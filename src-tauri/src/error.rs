//! 后端错误：只回 **错误码 + 模板参数 + 系统细节**，不回成品句子。
//!
//! 为什么不让后端直接拼中文：界面语言是**前端**才知道的信息，后端只有一份进程，
//! 不可能为了「用户刚把界面切成法语」重新加载一套文案。之前后端回中文句子、
//! 前端拿字符串去匹配翻译，两个毛病绕不过去：
//!
//! 1. 后端改一个字（哪怕只是补个标点）前端就整条失配，静默退回中文；
//! 2. 句子里的变量（`「a.md」已经存在`、`错误码 32`）是运行时才知道的，
//!    字符串匹配只能连变量一起匹配，等于永远匹配不上。
//!
//! 现在的分工：后端说「发生了什么」（`code`）和「跟谁有关」（`vars`），
//! 前端查词条表拼句子（`src/js/errors.js` → `tt()`）。系统给的细节
//! （`std::io` / Win32 的报错文本）原样放进 `detail` 一起送过去 —— 那段文字
//! 本来就是系统按自己的语言给的，不归我们翻译。

use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    /// 稳定错误码，形如 `io.read` / `name.invalid_chars`。前端按它查模板。
    pub code: &'static str,
    /// 模板参数，键名对上前端模板里的 `{name}` / `{rc}` / `{mb}`
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub vars: BTreeMap<&'static str, String>,
    /// 系统自己给的细节，前端拼在句末
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    /// 只有错误码，没有附加信息
    pub fn new(code: &'static str) -> Self {
        Self { code, vars: BTreeMap::new(), detail: None }
    }

    /// 带一条系统细节（io 错误、正则解析器的话）
    pub fn detail(code: &'static str, e: impl fmt::Display) -> Self {
        Self { code, vars: BTreeMap::new(), detail: Some(e.to_string()) }
    }

    /// 带一个模板参数
    pub fn var(code: &'static str, key: &'static str, v: impl fmt::Display) -> Self {
        let mut vars = BTreeMap::new();
        vars.insert(key, v.to_string());
        Self { code, vars, detail: None }
    }
}

/// 只给日志和 `panic!` 看：`io.read name=a.md: 系统找不到指定的文件`
impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.code)?;
        for (k, v) in &self.vars {
            write!(f, " {k}={v}")?;
        }
        if let Some(d) = &self.detail {
            write!(f, ": {d}")?;
        }
        Ok(())
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_without_empty_fields() {
        let e = AppError::new("file.binary");
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(s, r#"{"code":"file.binary"}"#);

        let e = AppError::var("entry.exists", "name", "a.md");
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(s, r#"{"code":"entry.exists","vars":{"name":"a.md"}}"#);

        let e = AppError::detail("io.read", "拒绝访问。");
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(s, r#"{"code":"io.read","detail":"拒绝访问。"}"#);
    }
}
