use std::{
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};

use futures::future::join_all;
use napi::{
    Error, Result, Status,
    bindgen_prelude::{Buffer, Promise},
    threadsafe_function::ThreadsafeFunction,
};
use napi_derive::napi;
use wasmtime::{
    Config, Engine, Instance, Module, Store, StoreLimits, StoreLimitsBuilder,
    component::ResourceTable,
};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

mod queued {
    wasmtime::component::bindgen!({ path: "wit", world: "queued-guest" });
}

const MAX_MESSAGE_BYTES: usize = 8_000_000;
const MAX_CAPABILITY_CALLS: usize = 1_024;
const MAX_CONCURRENT_CALLS: usize = 32;

fn js_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("{error:#}"))
}

fn engine() -> Result<Engine> {
    let mut config = Config::new();
    config.consume_fuel(true);
    config.wasm_component_model(true);
    config.epoch_interruption(true);
    Engine::new(&config).map_err(js_error)
}

fn store<T>(engine: &Engine, data: T, fuel: Option<u32>) -> Result<Store<T>> {
    let mut store = Store::new(engine, data);
    store.set_epoch_deadline(u64::MAX);
    store
        .set_fuel(u64::from(fuel.unwrap_or(50_000_000)))
        .map_err(js_error)?;
    Ok(store)
}

#[napi]
pub fn execute_wat(source: String, fuel: Option<u32>) -> Result<i32> {
    let engine = engine()?;
    let module = Module::new(&engine, source).map_err(js_error)?;
    let mut store = store(&engine, (), fuel.or(Some(100_000)))?;
    let instance = Instance::new(&mut store, &module, &[]).map_err(js_error)?;
    let run = instance
        .get_typed_func::<(), i32>(&mut store, "run")
        .map_err(js_error)?;
    run.call(&mut store, ()).map_err(js_error)
}

type JsonHostCallback = Arc<ThreadsafeFunction<String, Promise<String>, String, Status, false>>;

struct EpochDeadline {
    cancel: Option<mpsc::Sender<()>>,
}

impl EpochDeadline {
    fn new(engine: &Engine, timeout_ms: u32) -> Self {
        let (cancel, receiver) = mpsc::channel();
        let engine = engine.clone();
        thread::spawn(move || {
            if receiver
                .recv_timeout(Duration::from_millis(u64::from(timeout_ms)))
                .is_err()
            {
                engine.increment_epoch();
            }
        });
        Self {
            cancel: Some(cancel),
        }
    }
}

impl Drop for EpochDeadline {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
    }
}

struct QueuedState {
    table: ResourceTable,
    wasi: WasiCtx,
    limits: StoreLimits,
}

impl WasiView for QueuedState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

#[napi]
pub async fn execute_queued_javascript(
    component: Buffer,
    source: String,
    callback: JsonHostCallback,
    fuel: Option<u32>,
    timeout_ms: Option<u32>,
    memory_limit_mb: Option<u32>,
) -> Result<bool> {
    use queued::exports::pit::quickjs::runner::{Completion, PollState};
    use wasmtime::component::{Component, Linker};

    if source.len() > MAX_MESSAGE_BYTES {
        return Err(Error::from_reason("JavaScript source exceeds bounds"));
    }
    let engine = engine()?;
    let component = Component::new(&engine, component.as_ref()).map_err(js_error)?;
    let mut linker = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker).map_err(js_error)?;
    let memory_limit = usize::try_from(memory_limit_mb.unwrap_or(128))
        .map_err(|_| Error::from_reason("Invalid memory limit"))?
        .checked_mul(1024 * 1024)
        .ok_or_else(|| Error::from_reason("Invalid memory limit"))?;
    let state = QueuedState {
        table: ResourceTable::new(),
        wasi: WasiCtx::builder().build(),
        limits: StoreLimitsBuilder::new()
            .memory_size(memory_limit)
            .memories(8)
            .tables(16)
            .instances(32)
            .build(),
    };
    let mut store = store(&engine, state, fuel)?;
    store.limiter(|state| &mut state.limits);
    store.set_epoch_deadline(1);
    let _epoch = EpochDeadline::new(&engine, timeout_ms.unwrap_or(30_000));
    let guest =
        queued::QueuedGuest::instantiate(&mut store, &component, &linker).map_err(js_error)?;
    let runner = guest.pit_quickjs_runner();
    runner.call_initialize(&mut store).map_err(js_error)?;
    runner.call_start(&mut store, &source).map_err(js_error)?;

    let mut call_count = 0_usize;
    loop {
        match runner.call_poll(&mut store).map_err(js_error)? {
            PollState::Complete => return Ok(true),
            PollState::Failed(error) => return Err(Error::from_reason(error)),
            PollState::Pending => {}
        }
        let requests = runner.call_take_requests(&mut store).map_err(js_error)?;
        if requests.is_empty() {
            return Err(Error::from_reason(
                "QuickJS guest is pending without host requests",
            ));
        }
        call_count += requests.len();
        if call_count > MAX_CAPABILITY_CALLS {
            return Err(Error::from_reason("Pit host call limit exceeded"));
        }
        for requests in requests.chunks(MAX_CONCURRENT_CALLS) {
            let calls = requests.iter().map(|request| {
                let callback = callback.clone();
                let payload = request.payload.clone();
                async move {
                    if payload.len() > MAX_MESSAGE_BYTES {
                        return Err(Error::from_reason("Pit guest request exceeds bounds"));
                    }
                    let response = callback.call_async(payload).await?.await?;
                    if response.len() > MAX_MESSAGE_BYTES {
                        return Err(Error::from_reason("Pit host response exceeds bounds"));
                    }
                    Ok::<_, Error>(response)
                }
            });
            let responses = join_all(calls).await;
            for (request, response) in requests.iter().zip(responses) {
                let completion = match response {
                    Ok(value) => Completion::Success(value),
                    Err(error) => Completion::Failure(error.to_string()),
                };
                runner
                    .call_deliver(&mut store, request.id, &completion)
                    .map_err(js_error)?;
            }
        }
    }
}
