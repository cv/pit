use javy_plugin_api::{
    Config,
    javy::{Runtime, quickjs::prelude::Func},
    javy_plugin,
};

wit_bindgen::generate!({ world: "pit-javy-guest", generate_all });

fn config() -> Config {
    let mut config = Config::default();
    config.event_loop(true);
    config
}

fn modify_runtime(runtime: Runtime) -> Runtime {
    runtime.context().with(|ctx| {
        ctx.globals()
            .set(
                "pitCall",
                Func::from(|value: u32| -> u32 { crate::pit_call(value) }),
            )
            .unwrap();
    });
    runtime
}

struct Component;

javy_plugin!("pit-javy-guest", Component, config, modify_runtime);

export!(Component);
