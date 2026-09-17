use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
};

use javy::{
    Config, Runtime, from_js_error,
    quickjs::{Module, Persistent, Promise, Value, function::Func},
};

wit_bindgen::generate!({ world: "queued-guest", generate_all });

use exports::pit::quickjs::runner::{Completion, Guest, PollState, Request};

struct GuestRuntime {
    runtime: Runtime,
    requests: Rc<RefCell<VecDeque<Request>>>,
    next_id: Rc<Cell<u32>>,
    root: Option<Persistent<Promise<'static>>>,
    failure: Option<String>,
}

impl GuestRuntime {
    fn new() -> Result<Self, String> {
        let runtime = Runtime::new(Config::default()).map_err(|error| error.to_string())?;
        let requests = Rc::new(RefCell::new(VecDeque::new()));
        let next_id = Rc::new(Cell::new(1_u32));
        let request_queue = requests.clone();
        let request_next_id = next_id.clone();
        runtime
            .context()
            .with(|ctx| {
                ctx.globals().set(
                    "__pitEnqueue",
                    Func::from(move |payload: String| {
                        let id = request_next_id.get();
                        request_next_id.set(id.checked_add(1).ok_or_else(|| {
                            javy::quickjs::Error::new_from_js_message(
                                "u32",
                                "request id",
                                "Pit request id overflow",
                            )
                        })?);
                        request_queue
                            .borrow_mut()
                            .push_back(Request { id, payload });
                        Ok::<u32, javy::quickjs::Error>(id)
                    }),
                )?;
                ctx.eval::<(), _>(
                    r#"
                    globalThis.__pitPending = new Map();
                    globalThis.pitCall = (payload) => new Promise((resolve, reject) => {
                        const id = __pitEnqueue(payload);
                        __pitPending.set(id, { resolve, reject });
                    });
                    globalThis.__pitDeliver = (id, success, value) => {
                        const pending = __pitPending.get(id);
                        if (!pending) throw new Error("Unknown Pit request id: " + id);
                        __pitPending.delete(id);
                        if (success) pending.resolve(value);
                        else pending.reject(new Error(value));
                    };
                "#,
                )
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            runtime,
            requests,
            next_id,
            root: None,
            failure: None,
        })
    }

    fn start(&mut self, source: &str) {
        self.requests.borrow_mut().clear();
        self.next_id.set(1);
        self.failure = None;
        let result = self.runtime.context().with(|ctx| {
            let module = Module::declare(ctx.clone(), "pit-program", source)?;
            let (_module, promise) = module.eval()?;
            Ok::<_, javy::quickjs::Error>(Persistent::save(&ctx, promise))
        });
        match result {
            Ok(root) => self.root = Some(root),
            Err(error) => {
                self.root = None;
                self.failure = Some(
                    self.runtime
                        .context()
                        .with(|ctx| from_js_error(ctx.clone(), error).to_string()),
                );
            }
        }
    }

    fn deliver(&mut self, id: u32, completion: Completion) {
        let result = self.runtime.context().with(|ctx| {
            let deliver: javy::quickjs::Function<'_> = ctx.globals().get("__pitDeliver")?;
            match completion {
                Completion::Success(value) => deliver.call::<_, ()>((id, true, value)),
                Completion::Failure(error) => deliver.call::<_, ()>((id, false, error)),
            }
        });
        if let Err(error) = result {
            self.failure = Some(
                self.runtime
                    .context()
                    .with(|ctx| from_js_error(ctx.clone(), error).to_string()),
            );
        }
    }

    fn poll(&mut self) -> PollState {
        if let Some(error) = self.failure.take() {
            return PollState::Failed(error);
        }
        if let Err(error) = self.runtime.resolve_pending_jobs() {
            return PollState::Failed(error.to_string());
        }
        if let Some(error) = self.failure.take() {
            return PollState::Failed(error);
        }
        let Some(root) = self.root.as_ref() else {
            return PollState::Failed("QuickJS program has not been started".to_string());
        };
        self.runtime.context().with(|ctx| {
            let promise = match root.clone().restore(&ctx) {
                Ok(promise) => promise,
                Err(error) => return PollState::Failed(error.to_string()),
            };
            match promise.result::<Value<'_>>() {
                None => PollState::Pending,
                Some(Ok(_)) => PollState::Complete,
                Some(Err(error)) => {
                    PollState::Failed(from_js_error(ctx.clone(), error).to_string())
                }
            }
        })
    }
}

thread_local! {
    static STATE: RefCell<Option<GuestRuntime>> = const { RefCell::new(None) };
}

struct Component;

impl Guest for Component {
    fn initialize() {
        STATE.with_borrow_mut(|state| {
            *state = Some(GuestRuntime::new().expect("initialize QuickJS runtime"));
        });
    }

    fn start(source: String) {
        STATE.with_borrow_mut(|state| {
            state
                .as_mut()
                .expect("QuickJS runtime is not initialized")
                .start(&source);
        });
    }

    fn take_requests() -> Vec<Request> {
        STATE.with_borrow_mut(|state| {
            state
                .as_mut()
                .expect("QuickJS runtime is not initialized")
                .requests
                .borrow_mut()
                .drain(..)
                .collect()
        })
    }

    fn deliver(id: u32, completion: Completion) {
        STATE.with_borrow_mut(|state| {
            state
                .as_mut()
                .expect("QuickJS runtime is not initialized")
                .deliver(id, completion);
        });
    }

    fn poll() -> PollState {
        STATE.with_borrow_mut(|state| {
            state
                .as_mut()
                .expect("QuickJS runtime is not initialized")
                .poll()
        })
    }
}

export!(Component);
