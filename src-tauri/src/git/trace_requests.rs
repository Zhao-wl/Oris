//! 请求身份独立于历史阅读代次；取消先到也有效，已取消 ID 不可重用。
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Requests(Mutex<HashMap<(String, String), Request>>);
struct Request {
    cancelled: Arc<AtomicBool>,
    running: bool,
    created: Instant,
}
pub struct Guard<'a> {
    registry: &'a Requests,
    key: (String, String),
    pub cancelled: Arc<AtomicBool>,
}
impl Requests {
    pub fn begin(&self, repo: &str, id: &str) -> Result<Guard<'_>, GitError> {
        if id.is_empty() || id.len() > 128 {
            return Err(GitError::CommandFailed("无效追溯请求 ID".into()));
        }
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, r| r.running || r.created.elapsed() < Duration::from_secs(60));
        let key = (repo.to_owned(), id.to_owned());
        if entries.contains_key(&key) {
            return Err(GitError::StaleRequest);
        }
        if entries
            .iter()
            .filter(|((repository, _), r)| {
                repository == repo && r.running && !r.cancelled.load(Ordering::SeqCst)
            })
            .count()
            >= 2
        {
            return Err(GitError::CommandFailed(
                "该仓库已有两个追溯查询，请先取消或等待".into(),
            ));
        }
        if entries.len() >= 256 {
            return Err(GitError::CommandFailed("追溯请求过多，请稍后重试".into()));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        entries.insert(
            key.clone(),
            Request {
                cancelled: cancelled.clone(),
                running: true,
                created: Instant::now(),
            },
        );
        Ok(Guard {
            registry: self,
            key,
            cancelled,
        })
    }
    pub fn cancel(&self, repo: &str, id: &str) {
        if id.is_empty() || id.len() > 128 {
            return;
        }
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, r| r.running || r.created.elapsed() < Duration::from_secs(60));
        let key = (repo.to_owned(), id.to_owned());
        if let Some(request) = entries.get(&key) {
            request.cancelled.store(true, Ordering::SeqCst);
        } else if entries.len() < 256 {
            entries.insert(
                key,
                Request {
                    cancelled: Arc::new(AtomicBool::new(true)),
                    running: false,
                    created: Instant::now(),
                },
            );
        }
    }
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if let Some(request) = self
            .registry
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&self.key)
        {
            request.running = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_request_and_repository_scoped_and_can_arrive_first() {
        let requests = Requests::default();
        requests.cancel("a", "early");
        assert!(requests.begin("a", "early").is_err());
        let a = requests.begin("a", "live").unwrap();
        let b = requests.begin("b", "live").unwrap();
        requests.cancel("a", "live");
        assert!(a.cancelled.load(Ordering::SeqCst));
        assert!(!b.cancelled.load(Ordering::SeqCst));
        let _second = requests.begin("b", "second").unwrap();
        assert!(
            requests.begin("b", "third").is_err(),
            "每仓库最多两个活动查询"
        );
        requests.cancel("b", "live");
        let _replacement = requests.begin("b", "third").unwrap();
        drop(a);
        assert!(requests.begin("a", "live").is_err());
    }
}
