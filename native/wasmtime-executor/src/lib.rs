use std::sync::Arc;

use napi::{
    Error, Result, Status,
    bindgen_prelude::{Buffer, Promise},
    threadsafe_function::ThreadsafeFunction,
};
use napi_derive::napi;
use wasmtime::{Caller, Config, Engine, Extern, Instance, Linker, Module, Store};

const MAX_MESSAGE_BYTES: usize = 8_000_000;

fn js_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("{error:#}"))
}

fn engine() -> Result<Engine> {
    let mut config = Config::new();
    config.consume_fuel(true);
    config.wasm_component_model(true);
    Engine::new(&config).map_err(js_error)
}

fn store<T>(engine: &Engine, data: T, fuel: Option<u32>) -> Result<Store<T>> {
    let mut store = Store::new(engine, data);
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

type NumericHostCallback = Arc<ThreadsafeFunction<u32, Promise<u32>, u32, Status, false>>;
type JsonHostCallback = Arc<ThreadsafeFunction<String, Promise<String>, String, Status, false>>;

fn register_numeric_host(
    linker: &mut Linker<()>,
    module: &str,
    name: &str,
    callback: NumericHostCallback,
) -> Result<()> {
    linker
        .func_wrap_async(
            module,
            name,
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
    Ok(())
}

fn numeric_host_linker(engine: &Engine, callback: NumericHostCallback) -> Result<Linker<()>> {
    let mut linker = Linker::new(engine);
    register_numeric_host(&mut linker, "pit", "call", callback)?;
    Ok(linker)
}

#[napi]
pub async fn execute_async_host(
    source: String,
    callback: NumericHostCallback,
    fuel: Option<u32>,
) -> Result<i32> {
    let engine = engine()?;
    let module = Module::new(&engine, source).map_err(js_error)?;
    let linker = numeric_host_linker(&engine, callback)?;
    let mut store = store(&engine, (), fuel)?;
    let instance = linker
        .instantiate_async(&mut store, &module)
        .await
        .map_err(js_error)?;
    let run = instance
        .get_typed_func::<(), i32>(&mut store, "run")
        .map_err(js_error)?;
    run.call_async(&mut store, ()).await.map_err(js_error)
}

#[derive(Default)]
struct GuestState {
    responses: Vec<Option<Vec<u8>>>,
}

fn guest_memory<T>(caller: &mut Caller<'_, T>) -> wasmtime::Result<wasmtime::Memory> {
    caller
        .get_export("memory")
        .and_then(Extern::into_memory)
        .ok_or_else(|| wasmtime::Error::msg("Javy guest does not export memory"))
}

fn checked_region(pointer: i32, length: i32) -> wasmtime::Result<(usize, usize)> {
    if pointer < 0 || length < 0 || length as usize > MAX_MESSAGE_BYTES {
        return Err(wasmtime::Error::msg("Pit guest message exceeds bounds"));
    }
    Ok((pointer as usize, length as usize))
}

fn response_index(handle: i32, state: &GuestState) -> wasmtime::Result<usize> {
    let index = usize::try_from(handle - 1)
        .map_err(|_| wasmtime::Error::msg("Invalid Pit response handle"))?;
    if state
        .responses
        .get(index)
        .and_then(Option::as_ref)
        .is_none()
    {
        return Err(wasmtime::Error::msg("Invalid Pit response handle"));
    }
    Ok(index)
}

fn json_host_linker(engine: &Engine, callback: JsonHostCallback) -> Result<Linker<GuestState>> {
    let mut linker = Linker::new(engine);
    linker
        .func_wrap_async(
            "$root",
            "pit-call-start",
            move |mut caller: Caller<'_, GuestState>, (pointer, length): (i32, i32)| {
                let callback = callback.clone();
                Box::new(async move {
                    let (pointer, length) = checked_region(pointer, length)?;
                    let memory = guest_memory(&mut caller)?;
                    let mut request = vec![0_u8; length];
                    memory.read(&caller, pointer, &mut request)?;
                    let request = String::from_utf8(request)
                        .map_err(|_| wasmtime::Error::msg("Pit guest request is not UTF-8"))?;
                    let promise = callback
                        .call_async(request)
                        .await
                        .map_err(|error| wasmtime::Error::msg(error.to_string()))?;
                    let response = promise
                        .await
                        .map_err(|error| wasmtime::Error::msg(error.to_string()))?
                        .into_bytes();
                    if response.len() > MAX_MESSAGE_BYTES {
                        return Err(wasmtime::Error::msg("Pit host response exceeds bounds"));
                    }
                    let state = caller.data_mut();
                    state.responses.push(Some(response));
                    i32::try_from(state.responses.len())
                        .map_err(|_| wasmtime::Error::msg("Too many Pit host responses"))
                })
            },
        )
        .map_err(js_error)?;
    linker
        .func_wrap(
            "$root",
            "pit-call-len",
            |caller: Caller<'_, GuestState>, handle: i32| -> wasmtime::Result<i32> {
                let index = response_index(handle, caller.data())?;
                i32::try_from(caller.data().responses[index].as_ref().unwrap().len())
                    .map_err(|_| wasmtime::Error::msg("Pit host response exceeds bounds"))
            },
        )
        .map_err(js_error)?;
    linker
        .func_wrap(
            "$root",
            "pit-call-read",
            |mut caller: Caller<'_, GuestState>,
             handle: i32,
             pointer: i32|
             -> wasmtime::Result<()> {
                let index = response_index(handle, caller.data())?;
                let response = caller.data_mut().responses[index].take().unwrap();
                let (pointer, _) = checked_region(pointer, response.len() as i32)?;
                let memory = guest_memory(&mut caller)?;
                memory.write(&mut caller, pointer, &response)?;
                Ok(())
            },
        )
        .map_err(js_error)?;
    Ok(linker)
}

fn result_field(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("four-byte result field"),
    )
}

#[napi]
pub async fn execute_javascript(
    guest: Buffer,
    source: String,
    callback: JsonHostCallback,
    fuel: Option<u32>,
) -> Result<bool> {
    let engine = engine()?;
    let module = Module::new(&engine, guest.as_ref()).map_err(js_error)?;
    let linker = json_host_linker(&engine, callback)?;
    let mut store = store(&engine, GuestState::default(), fuel)?;
    let instance = linker
        .instantiate_async(&mut store, &module)
        .await
        .map_err(js_error)?;
    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or_else(|| Error::from_reason("Javy guest does not export memory"))?;
    let initialize = instance
        .get_typed_func::<(), ()>(&mut store, "initialize-runtime")
        .map_err(js_error)?;
    initialize
        .call_async(&mut store, ())
        .await
        .map_err(js_error)?;

    let source_bytes = source.as_bytes();
    let source_length = i32::try_from(source_bytes.len())
        .map_err(|_| Error::from_reason("JavaScript source is too large"))?;
    let realloc = instance
        .get_typed_func::<(i32, i32, i32, i32), i32>(&mut store, "cabi_realloc")
        .map_err(js_error)?;
    let source_pointer = realloc
        .call_async(&mut store, (0, 0, 1, source_length))
        .await
        .map_err(js_error)?;
    memory
        .write(&mut store, source_pointer as usize, source_bytes)
        .map_err(js_error)?;

    let compile = instance
        .get_typed_func::<(i32, i32), i32>(&mut store, "compile-src")
        .map_err(js_error)?;
    let result_pointer = compile
        .call_async(&mut store, (source_pointer, source_length))
        .await
        .map_err(js_error)?;
    let mut result = [0_u8; 12];
    memory
        .read(&store, result_pointer as usize, &mut result)
        .map_err(js_error)?;
    let discriminant = result_field(&result, 0);
    let bytecode_pointer = result_field(&result, 4);
    let bytecode_length = result_field(&result, 8);
    if discriminant != 0 {
        let mut message = vec![0_u8; bytecode_length as usize];
        memory
            .read(&store, bytecode_pointer as usize, &mut message)
            .map_err(js_error)?;
        return Err(Error::from_reason(
            String::from_utf8_lossy(&message).into_owned(),
        ));
    }

    let invoke = instance
        .get_typed_func::<(i32, i32, i32, i32, i32), ()>(&mut store, "invoke")
        .map_err(js_error)?;
    invoke
        .call_async(&mut store, (bytecode_pointer, bytecode_length, 0, 0, 0))
        .await
        .map_err(js_error)?;
    Ok(true)
}
