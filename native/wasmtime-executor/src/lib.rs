use std::sync::Arc;

use napi::{
    Error, Result, Status, bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction,
};
use napi_derive::napi;
use wasmtime::{Caller, Config, Engine, Instance, Linker, Module, Store};

fn js_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("{error:#}"))
}

fn engine() -> Result<Engine> {
    let mut config = Config::new();
    config.consume_fuel(true);
    config.wasm_component_model(true);
    Engine::new(&config).map_err(js_error)
}

fn store(engine: &Engine, fuel: Option<u32>) -> Result<Store<()>> {
    let mut store = Store::new(engine, ());
    store
        .set_fuel(u64::from(fuel.unwrap_or(100_000)))
        .map_err(js_error)?;
    Ok(store)
}

#[napi]
pub fn execute_wat(source: String, fuel: Option<u32>) -> Result<i32> {
    let engine = engine()?;
    let module = Module::new(&engine, source).map_err(js_error)?;
    let mut store = store(&engine, fuel)?;
    let instance = Instance::new(&mut store, &module, &[]).map_err(js_error)?;
    let run = instance
        .get_typed_func::<(), i32>(&mut store, "run")
        .map_err(js_error)?;
    run.call(&mut store, ()).map_err(js_error)
}

type AsyncHostCallback = Arc<ThreadsafeFunction<u32, Promise<u32>, u32, Status, false>>;

#[napi]
pub async fn execute_async_host(
    source: String,
    callback: AsyncHostCallback,
    fuel: Option<u32>,
) -> Result<i32> {
    let engine = engine()?;
    let module = Module::new(&engine, source).map_err(js_error)?;
    let mut linker = Linker::new(&engine);
    linker
        .func_wrap_async(
            "pit",
            "call",
            move |_caller: Caller<'_, ()>, (value,): (i32,)| {
                let callback = callback.clone();
                Box::new(async move {
                    let promise = callback
                        .call_async(value as u32)
                        .await
                        .map_err(|error| wasmtime::Error::msg(error.to_string()))?;
                    let result = promise
                        .await
                        .map_err(|error| wasmtime::Error::msg(error.to_string()))?;
                    Ok(result as i32)
                })
            },
        )
        .map_err(js_error)?;

    let mut store = store(&engine, fuel)?;
    let instance = linker
        .instantiate_async(&mut store, &module)
        .await
        .map_err(js_error)?;
    let run = instance
        .get_typed_func::<(), i32>(&mut store, "run")
        .map_err(js_error)?;
    run.call_async(&mut store, ()).await.map_err(js_error)
}
