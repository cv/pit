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
                Func::from(|request: String| -> String {
                    let request = request.into_bytes();
                    let handle =
                        crate::pit_call_start(request.as_ptr() as u32, request.len() as u32);
                    let length = crate::pit_call_len(handle);
                    let mut response = vec![0_u8; length as usize];
                    crate::pit_call_read(handle, response.as_mut_ptr() as u32);
                    String::from_utf8(response).expect("Pit host response must be UTF-8")
                }),
            )
            .unwrap();
    });
    runtime
}

struct Component;

javy_plugin!("pit-javy-guest", Component, config, modify_runtime);

export!(Component);
