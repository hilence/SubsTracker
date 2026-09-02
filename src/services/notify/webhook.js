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
 *
 * @param {any} template   - 模板对象（已解析的 JSON）
 * @param {Record<string,any>} data  - 用于替换的数据
 * @returns {any} 替换后的新对象
 */
function applyTemplate(template, data) {
  if (typeof template === 'string') {
    // 替换字符串中的占位符
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const val = data[key];
        return val != null ? String(val) : '';
      }
      return ''; // 未找到的占位符替换为空字符串
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
    // 基本类型（number, boolean, null 等）直接返回
    return template;
  }
}

/**
 * 将 content 字符串中的空格分隔的 "字段名: 值" 转换为多行显示。
 * 例如： "类型: 其他 金额: £0.05/周期 ..." -> "类型: 其他\n金额: £0.05/周期\n..."
 * 如果第一个 token 不是键值对（不以冒号结尾），则视为标题，单独成行。
 */
function formatContentToLines(content) {
  if (!content || typeof content !== 'string') return content;

  const parts = content.split(/\s+/);
  const lines = [];
  let currentLine = [];

  // 处理第一个 token：如果它不是键（不以冒号结尾），则单独作为标题行
  if (parts.length > 0 && !parts[0].endsWith(':')) {
    lines.push(parts[0]);
    parts.shift(); // 移除已处理的标题
  }

  // 剩余部分按键值对处理
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (token.endsWith(':')) {
      if (currentLine.length > 0) {
        lines.push(currentLine.join(' '));
        currentLine = [];
      }
      currentLine.push(token);
    } else {
      currentLine.push(token);
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine.join(' '));
  }

  return lines.join('\n');
}

/**
 * 构造可供模板替换的变量集合。
 *
 * @param {import('./channel.js').ChannelPayload} payload
 * @param {any} config
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

  // 新增：将 content 转换为多行格式
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
    // 新增的变量，供模板使用
    contentLines,
    // 扩展字段，便于规则化模板
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
