// @ts-check
/**
 * Webhook 通知渠道
 *
 * 支持自定义请求方法、Header、消息模板（{{title}} / {{content}} / {{tags}} 等）。
 */
import { ok, fail, errorMessage } from './channel.js';
import { formatLocalDate } from '../../core/time.js';

/**
 * 递归替换模板对象中的所有 {{key}} 占位符。
 * 保留原始数据类型（字符串、数字等），换行符等特殊字符不会被二次转义。
 */
function applyTemplate(template, data) {
  if (typeof template === 'string') {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const val = data[key];
        return val != null ? String(val) : '';
      }
      return '';
    });
  } else if (Array.isArray(template)) {
    return template.map(item => applyTemplate(item, data));
  } else if (template && typeof template === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = applyTemplate(value, data);
    }
    return result;
  } else {
    return template;
  }
}

/**
 * 将 content 字符串中的 "字段名: 值" 转换为多行显示。
 * 支持中文和英文冒号，正确提取每个字段的值（值中可包含空格）。
 */
function formatContentToLines(content) {
  if (!content || typeof content !== 'string') return content;

  // 匹配字段名（中英文）后跟中文或英文冒号
  const regex = /([\u4e00-\u9fa5a-zA-Z]+)[:：]\s*/g;
  const matches = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push({
      key: match[1],
      index: match.index,
      end: regex.lastIndex
    });
  }

  if (matches.length === 0) {
    // 没有匹配到任何字段名，原样返回
    return content;
  }

  // 提取标题（第一个字段之前的内容）
  const firstMatch = matches[0];
  let title = content.substring(0, firstMatch.index).trim();
  const lines = [];
  if (title) lines.push(title);

  // 处理每个字段
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    // 值的起始位置：字段名 + 冒号之后
    const start = current.index + current.key.length + 1; // 跳过冒号
    // 值的结束位置：下一个字段的起始位置 或 字符串末尾
    const end = next ? next.index : content.length;
    let value = content.substring(start, end).trim();
    // 去除可能多余的前导冒号（如果有）
    if (value.startsWith(':') || value.startsWith('：')) value = value.substring(1).trim();
    lines.push(`${current.key}: ${value}`);
  }

  return lines.join('\n');
}

/**
 * 构造可供模板替换的变量集合。
 */
function buildTemplateData(payload, config) {
  const tagsArray = Array.isArray(payload.metadata?.tags)
    ? payload.metadata.tags
        .filter((t) => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim())
    : [];
  const tagsBlock = tagsArray.length ? tagsArray.map((t) => `- ${t}`).join('\n') : '';
  const tagsLine = tagsArray.length ? '标签：' + tagsArray.join('、') : '';
  const timestamp = formatLocalDate(new Date(), config?.TIMEZONE || 'UTC', 'datetime');
  const formattedMessage = [
    payload.title,
    payload.content,
    tagsLine,
    `发送时间：${timestamp}`
  ]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n');

  const contentLines = formatContentToLines(payload.content);

  return {
    title: payload.title,
    content: payload.content,
    tags: tagsBlock,
    tagsLine,
    rawTags: tagsArray,
    timestamp,
    formattedMessage,
    message: formattedMessage,
    contentLines,
    daysRemaining: payload.metadata?.daysRemaining ?? '',
    ruleType: payload.metadata?.ruleType ?? '',
    ruleValue: payload.metadata?.ruleValue ?? ''
  };
}

/** @type {import('./channel.js').Channel} */
export const webhookChannel = {
  name: 'webhook',

  validateConfig(config) {
    if (!config.WEBHOOK_URL) return { ok: false, error: '缺少 WEBHOOK_URL' };
    return { ok: true };
  },

  async send(payload, config) {
    const v = webhookChannel.validateConfig(config);
    if (!v.ok) return fail('webhook', v.error || '配置无效');

    let headers = { 'Content-Type': 'application/json' };
    if (config.WEBHOOK_HEADERS) {
      try {
        const customHeaders = JSON.parse(config.WEBHOOK_HEADERS);
        headers = { ...headers, ...customHeaders };
      } catch {
        console.warn('[Webhook] 自定义请求头格式错误，使用默认请求头');
      }
    }

    const data = buildTemplateData(payload, config);
    let requestBody;
    if (config.WEBHOOK_TEMPLATE) {
      try {
        const template = JSON.parse(config.WEBHOOK_TEMPLATE);
        requestBody = applyTemplate(template, data);
      } catch {
        console.warn('[Webhook] 消息模板格式错误，使用默认格式');
        requestBody = { ...data };
      }
    } else {
      requestBody = { ...data };
    }

    try {
      const r = await fetch(config.WEBHOOK_URL, {
        method: config.WEBHOOK_METHOD || 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });
      const text = await r.text().catch(() => '');
      return r.ok ? ok('webhook', text) : fail('webhook', `HTTP ${r.status}`, text);
    } catch (err) {
      return fail('webhook', errorMessage(err));
    }
  },

  async test(config) {
    return webhookChannel.send(
      { title: '订阅管理 - 测试通知', content: '这是一条 Webhook 测试通知。' },
      config
    );
  }
};

/** @deprecated 旧版兼容函数 */
export async function sendWebhookNotification(title, content, config, metadata = {}) {
  const r = await webhookChannel.send({ title, content, metadata }, config);
  if (!r.success) console.error('[Webhook]', r.error);
  return r.success;
}
