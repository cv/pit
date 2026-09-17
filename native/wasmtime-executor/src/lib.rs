use napi::{Error, Result};
use napi_derive::napi;
use wasmtime::{Config, Engine, Instance, Module, Store};

fn js_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("{error:#}"))
}

#[napi]
pub fn execute_wat(source: String, fuel: Option<u32>) -> Result<i32> {
    let mut config = Config::new();
    config.consume_fuel(true);
    config.wasm_component_model(true);

    let engine = Engine::new(&config).map_err(js_error)?;
    let module = Module::new(&engine, source).map_err(js_error)?;
    let mut store = Store::new(&engine, ());
    store
        .set_fuel(u64::from(fuel.unwrap_or(100_000)))
        .map_err(js_error)?;

    let instance = Instance::new(&mut store, &module, &[]).map_err(js_error)?;
    let run = instance
        .get_typed_func::<(), i32>(&mut store, "run")
        .map_err(js_error)?;
    run.call(&mut store, ()).map_err(js_error)
}
