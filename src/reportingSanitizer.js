"use strict";
var ReportingSanitizer = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/sanitize.ts
  var sanitize_exports = {};
  __export(sanitize_exports, {
    originOnly: () => originOnly,
    safeMarkdown: () => safeMarkdown,
    sanitizeContext: () => sanitizeContext,
    sanitizeText: () => sanitizeText
  });
  var SECRET_KEY = /authorization|cookie|token|password|passwd|secret|credential|api.?key|email|session|csrf|anon.?id/i;
  function sanitizeText(input, max = 8e3) {
    return input.slice(0, 32e3).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED]").replace(/\b(?:Authorization|Cookie|Set-Cookie)\s*:[^\r\n]*/gi, "[REDACTED HEADER]").replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]").replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]").replace(/((?:token|password|passwd|secret|api[_-]?key|credential|csrf|session)[\w-]*["']?\s*[:=]\s*)["']?[^\s,;"'}()<>\[\]]+["']?/gi, "$1[REDACTED]").replace(/\b(?:https?|chrome-extension):\/\/[^\s<>"')]+/gi, (value) => {
      try {
        const u = new URL(value);
        const path = u.pathname.replace(/\b\d{4,}\b/g, ":id").replace(/[a-f0-9]{24,}/gi, ":id");
        return `${u.protocol}//${u.host}${path}`;
      } catch {
        return "[URL]";
      }
    }).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]").replace(/\b\d{6,}\b/g, "[ID]").replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[REDACTED]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
  }
  function sanitizeContext(value, depth = 0) {
    if (depth > 4) return "[TRUNCATED]";
    if (typeof value === "string") return sanitizeText(value, 512);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeContext(v, depth + 1));
    if (typeof value === "object" && value) return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [
      sanitizeText(k, 64),
      SECRET_KEY.test(k) || /^(?:itemId|memberId|userId|accountId|newItemId|url|href)$/i.test(k) ? "[REDACTED]" : sanitizeContext(v, depth + 1)
    ]));
    return null;
  }
  function originOnly(value) {
    try {
      const u = new URL(value);
      return u.protocol === "https:" ? u.origin : "";
    } catch {
      return "";
    }
  }
  function safeMarkdown(value) {
    return sanitizeText(value).replace(/@/g, "\uFF20").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_{}\[\]()#+.!|~-])/g, "\\$1");
  }
  return __toCommonJS(sanitize_exports);
})();
