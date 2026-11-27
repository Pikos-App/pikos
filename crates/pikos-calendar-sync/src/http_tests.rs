use std::collections::HashMap;
use std::sync::Mutex;

use super::*;
use crate::replay::{Exchange, Fixture, Replay};

struct Capture(Mutex<Vec<String>>);

impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        let is_http = record.target() == "pikos_calendar_sync::http";
        if is_http {
            self.0.lock().unwrap().push(record.args().to_string());
        }
    }

    fn flush(&self) {}
}

static CAPTURE: Capture = Capture(Mutex::new(Vec::new()));

/// A refused connection, a DNS miss and a certificate rejection used to share one message.
/// The reason now leads with reqwest's class, and the URL, which can carry a token, is gone.
#[tokio::test]
async fn a_failed_request_says_why_and_not_where() {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let request = client().get(format!(
        "http://127.0.0.1:{port}/calendars/me%40example.com/events?syncToken=query-secret"
    ));

    let err = fetch(request).await.err().expect("nothing listens there");
    let reason = failure(&err);

    assert!(reason.starts_with("connect: "), "{reason}");
    assert!(!reason.contains("query-secret"), "{reason}");
    assert!(!reason.contains("example.com"), "{reason}");
}

#[test]
fn client_builds() {
    let _ = client();
}

#[tokio::test]
async fn a_request_logs_where_it_went_and_none_of_its_secrets() {
    let _ = log::set_logger(&CAPTURE);
    log::set_max_level(log::LevelFilter::Info);
    let fixture = Fixture {
        recorded: String::new(),
        origins: vec![],
        exchanges: vec![Exchange {
            method: "GET".into(),
            path: "/logged/probe".into(),
            status: 200,
            headers: HashMap::new(),
            body: "hello".into(),
        }],
    };
    let replay = Replay::start(&fixture).await;

    let request = client()
        .get(format!(
            "{}/logged/probe?syncToken=query-secret",
            replay.url
        ))
        .basic_auth("someone", Some("password-secret"))
        .body("body-secret");
    fetch(request).await.expect("the replay answers");

    let lines = CAPTURE.0.lock().unwrap().clone();
    let line = lines
        .iter()
        .find(|l| l.contains("path=/logged/probe"))
        .expect("the request was logged");
    assert_eq!(
        line,
        "request method=GET host=127.0.0.1 path=/logged/probe status=200 bytes=5"
    );
}
