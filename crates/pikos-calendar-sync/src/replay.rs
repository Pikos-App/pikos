//! A calendar server for tests that answers from a recorded exchange.
//!
//! The fixture is what `scripts/sync-record.py` wrote while the app talked to a real provider.
//! Requests are matched by method and path, each answered with that pair's recorded responses in
//! order, the last one again once they run out. The query string is left out of the match, like
//! the body, because sync requests carry a window computed from today and so never repeat a
//! recorded one. The recorded origin is swapped for this
//! server's wherever a response names it, so redirects and absolute hrefs land back here.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, serde::Deserialize)]
pub struct Fixture {
    pub recorded: String,
    pub origins: Vec<String>,
    pub exchanges: Vec<Exchange>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Exchange {
    pub method: String,
    pub path: String,
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

type Queues = Arc<Mutex<HashMap<(String, String), VecDeque<Exchange>>>>;

pub struct Replay {
    pub url: String,
    queues: Queues,
    unanswered: Arc<Mutex<Vec<String>>>,
}

impl Replay {
    pub async fn start(fixture: &Fixture) -> Replay {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the replay server");
        let url = format!("http://{}", listener.local_addr().expect("replay address"));
        let mut queues: HashMap<(String, String), VecDeque<Exchange>> = HashMap::new();
        for recorded in &fixture.exchanges {
            let mut exchange = recorded.clone();
            for origin in &fixture.origins {
                // iCloud names its partition host with the default port spelled out.
                let spellings = [
                    format!("{origin}:443"),
                    format!("{origin}:80"),
                    origin.clone(),
                ];
                for spelled in &spellings {
                    exchange.body = exchange.body.replace(spelled.as_str(), &url);
                    for value in exchange.headers.values_mut() {
                        *value = value.replace(spelled.as_str(), &url);
                    }
                }
            }
            queues
                .entry((exchange.method.clone(), without_query(&exchange.path)))
                .or_default()
                .push_back(exchange);
        }
        let queues: Queues = Arc::new(Mutex::new(queues));
        let unanswered = Arc::new(Mutex::new(Vec::new()));
        let (q, u) = (queues.clone(), unanswered.clone());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream, q.clone(), u.clone()));
            }
        });
        Replay {
            url,
            queues,
            unanswered,
        }
    }

    /// Whether every recorded response has been served, so a client that keeps syncing has seen
    /// all the recording holds, upstream changes included.
    pub fn spent(&self) -> bool {
        self.queues
            .lock()
            .expect("replay lock")
            .values()
            .all(|queue| queue.len() <= 1)
    }

    /// Requests the recording had no answer for: the client asked something it didn't then.
    pub fn unanswered(&self) -> Vec<String> {
        self.unanswered.lock().expect("replay lock").clone()
    }
}

fn without_query(path: &str) -> String {
    path.split('?').next().unwrap_or(path).to_string()
}

async fn serve(stream: TcpStream, queues: Queues, unanswered: Arc<Mutex<Vec<String>>>) {
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let (Some(method), Some(path)) = (parts.next(), parts.next()) else {
            return;
        };
        let (method, path) = (method.to_string(), without_query(path));
        let mut length = 0;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).await.unwrap_or(0) == 0 {
                return;
            }
            if header == "\r\n" || header == "\n" {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).await.is_err() {
            return;
        }

        let answer = {
            let mut queues = queues.lock().expect("replay lock");
            queues
                .get_mut(&(method.clone(), path.clone()))
                .and_then(|queue| {
                    if queue.len() > 1 {
                        queue.pop_front()
                    } else {
                        queue.front().cloned()
                    }
                })
        };
        let response = match answer {
            Some(exchange) => {
                let mut head = format!("HTTP/1.1 {} Replayed\r\n", exchange.status);
                for (name, value) in &exchange.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str(&format!("content-length: {}\r\n\r\n", exchange.body.len()));
                [head.into_bytes(), exchange.body.into_bytes()].concat()
            }
            None => {
                unanswered
                    .lock()
                    .expect("replay lock")
                    .push(format!("{method} {path}"));
                b"HTTP/1.1 404 Not Recorded\r\ncontent-length: 0\r\n\r\n".to_vec()
            }
        };
        if reader.get_mut().write_all(&response).await.is_err() {
            return;
        }
    }
}
