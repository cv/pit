use std::sync::Arc;

use napi::{
    Error, Result, Status,
    bindgen_prelude::{Buffer, Promise},
    threadsafe_function::ThreadsafeFunction,
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
        .set_fuel(u64::from(fuel.unwrap_or(50_000_000)))
        .map_err(js_error)?;
    Ok(store)
}

#[napi]
pub fn execute_wat(source: String, fuel: Option<u32>) -> Result<i32> {
    let engine = engine()?;
    let module = Module::new(&engine, source).map_err(js_error)?;
    let mut store = store(&engine, fuel.or(Some(100_000)))?;
    let instance = Instance::new(&mut store, &module, &[]).map_err(js_error)?;
    let run = instance
        .get_typed_func::<(), i32>(&mut store, "run")
        .map_err(js_error)?;
    run.call(&mut store, ()).map_err(js_error)
}

type AsyncHostCallback = Arc<ThreadsafeFunction<u32, Promise<u32>, u32, Status, false>>;

fn register_async_host(
    linker: &mut Linker<()>,
    module: &str,
    name: &str,
    callback: AsyncHostCallback,
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

fn async_host_linker(engine: &Engine, callback: AsyncHostCallback) -> Result<Linker<()>> {
    let mut linker = Linker::new(engine);
    register_async_host(&mut linker, "pit", "call", callback.clone())?;
    register_async_host(&mut linker, "$root", "pit-call", callback)?;
    Ok(linker)
}

#[napi]
pub async fn execute_async_host(
    source: String,
    callback: AsyncHostCallback,
    fuel: Option<u32>,
) -> Result<i32> {
    let engine = engine()?;
    let module = Module::new(&engine, source).map_err(js_error)?;
    let linker = async_host_linker(&engine, callback)?;
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
    callback: AsyncHostCallback,
    fuel: Option<u32>,
) -> Result<bool> {
    let engine = engine()?;
    let module = Module::new(&engine, guest.as_ref()).map_err(js_error)?;
    let linker = async_host_linker(&engine, callback)?;
    let mut store = store(&engine, fuel)?;
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
