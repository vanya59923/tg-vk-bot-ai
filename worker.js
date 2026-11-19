// ============================================================
//  Constants
// ============================================================

const VK_API_VERSION = "5.199";
const MAX_BRIDGES = 5;
const DAILY_PHOTO_LIMIT = 50;
const MAX_VOICE_DURATION = 20;
const MAX_VOICE_BYTES = 2097152;       // 2 МБ
const MAX_VIDEO_DURATION = 60;
const MAX_VIDEO_BYTES = 15728640;      // 15 МБ
const VIDEO_MIN_BYTES = 2097152;
const VIDEO_BYTES_PER_SEC = 262144;    // 256 КБ/с
const MAX_DOC_BYTES = 10485760;        // 10 МБ

const TG_KEYBOARD = {
  keyboard: [
    [{ text: "создать мост" },       { text: "просмотреть мосты" }],
    [{ text: "сменить получателя" }, { text: "отвязать мост" }],
    [{ text: "общий лимит" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const VK_KEYBOARD = {
  one_time: false,
  buttons: [
    [
      { action: { type: "text", label: "создать мост" },       color: "primary"   },
      { action: { type: "text", label: "просмотреть мосты" },  color: "primary"   },
    ],
    [
      { action: { type: "text", label: "сменить получателя" }, color: "secondary" },
      { action: { type: "text", label: "отвязать мост" },      color: "negative"  },
    ],
    [
      { action: { type: "text", label: "общий лимит" },        color: "secondary" },
    ],
  ],
};

const ERR_FORWARD       = "не удалось переслать, попробуйте ещё раз";
const ERR_DOWNLOAD      = "не удалось скачать, попробуйте ещё раз";
const ERR_ALBUM         = "альбомы не поддерживаются, пришлите по одному";
const ERR_LIMIT         = "дневной лимит фото закончился, попробуйте завтра";
const ERR_NO_ACTIVE     = "у вас нет активного получателя. Нажмите «создать мост» или подключите чужой код";
const ERR_ONLY_OWN      = "это ваш собственный код";
const ERR_CODE_NOT_FOUND= "код не найден";
const ERR_SELF_FULL     = "у вас уже 5 мостов";
const ERR_PARTNER_FULL  = "у собеседника уже 5 мостов";
const ERR_ALREADY_LINKED= "вы уже связаны с этим собеседником";
const ERR_VOICE_LIMIT   = "голосовое должно быть до 20 секунд и до 2 МБ";
const ERR_VIDEO_LIMIT   = "видео/кружочек должно быть до 60 секунд и в пределах допустимого веса";
const ERR_DOC_TOO_BIG   = "Файл слишком тяжелый (максимум 10 МБ).";
const ERR_VK_BLOCKED    = "этот тип файла заблокирован сервером ВК";
const OK_DELIVERED      = "сообщение доставлено";

// ============================================================
//  Small helpers
// ============================================================

const todayStr = () => new Date().toISOString().slice(0, 10);
const platformLabel = (p) => (p === "tg" ? "ТГ" : "ВК");
const kbFor = (p) => (p === "tg" ? TG_KEYBOARD : VK_KEYBOARD);

function randId() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 2147483647);
}

function makeCaption(senderName, platform, original) {
  const prefix = `[${senderName} | ${platformLabel(platform)}]`;
  const t = (original || "").trim();
  return t ? `${prefix}: ${t}` : prefix;
}

function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }

// ============================================================
//  Code generator
// ============================================================

function randomLetter() { return String.fromCharCode(97 + Math.floor(Math.random() * 26)); }
function randomDigit()  { return String(Math.floor(Math.random() * 10)); }
function keyCandidate() {
  return randomLetter() + randomLetter() + randomLetter() + "-" +
         randomDigit()  + randomDigit()  + randomDigit()  + "-" +
         randomLetter() + randomLetter() + randomLetter();
}
async function generateUniqueKey(env) {
  for (;;) {
    const code = keyCandidate();
    if ((await env.BOT_KV.get(`bridgekey:${code}`)) === null) return code;
  }
}

// ============================================================
//  KV helpers
// ============================================================

const getOwnerByKey = (env, code) => env.BOT_KV.get(`bridgekey:${code}`, "json");
const saveOwnerByKey = (env, code, owner) => env.BOT_KV.put(`bridgekey:${code}`, JSON.stringify(owner));
const getUser  = (env, p, id)      => env.BOT_KV.get(`user:${p}:${id}`, "json");
const saveUser = (env, p, id, u)   => env.BOT_KV.put(`user:${p}:${id}`, JSON.stringify(u));

async function ensureUser(env, platform, userId, username) {
  let user = await getUser(env, platform, userId);
  if (!user) {
    const code = await generateUniqueKey(env);
    user = {
      myCode: code,
      myName: username,
      bridges: [],
      activeCode: null,
      state: "idle",
    };
    await saveOwnerByKey(env, code, { platform, userId });
    await saveUser(env, platform, userId, user);
    return user;
  }
  if (username && user.myName !== username) {
    user.myName = username;
    await saveUser(env, platform, userId, user);
  }
  return user;
}

// ============================================================
//  Daily stats (single key per day)
// ============================================================

async function getDaily(env) {
  return (await env.BOT_KV.get(`daily:${todayStr()}`, "json")) || { photos: 0, media: 0 };
}
async function putDaily(env, d) {
  await env.BOT_KV.put(`daily:${todayStr()}`, JSON.stringify(d), { expirationTtl: 86400 });
}
async function bumpMedia(env) {
  const d = await getDaily(env); d.media = (d.media || 0) + 1; await putDaily(env, d);
}
async function tryConsumePhoto(env) {
  const d = await getDaily(env);
  if ((d.photos || 0) >= DAILY_PHOTO_LIMIT) return false;
  d.photos = (d.photos || 0) + 1;
  await putDaily(env, d);
  return true;
}
async function refundPhoto(env) {
  const d = await getDaily(env);
  if ((d.photos || 0) > 0) { d.photos -= 1; await putDaily(env, d); }
}

// ============================================================
//  TG send helpers
// ============================================================

async function sendTg(env, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.ok;
}

async function tgCall(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: "POST", body: params });
  const d = await r.json();
  return d.ok === true;
}

async function sendTgPhotoFileId(env, chatId, fileId, caption) {
  const p = new URLSearchParams({ chat_id: String(chatId), photo: fileId });
  if (caption) p.set("caption", caption.slice(0, 1024));
  return tgCall(env, "sendPhoto", p);
}
async function sendTgPhotoUrl(env, chatId, url, caption) {
  const p = new URLSearchParams({ chat_id: String(chatId), photo: url });
  if (caption) p.set("caption", caption.slice(0, 1024));
  return tgCall(env, "sendPhoto", p);
}
async function sendTgVoiceFileId(env, chatId, fileId, caption) {
  const p = new URLSearchParams({ chat_id: String(chatId), voice: fileId });
  if (caption) p.set("caption", caption.slice(0, 1024));
  return tgCall(env, "sendVoice", p);
}
async function sendTgVoiceBlob(env, chatId, blob, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("voice", blob, "voice.ogg");
  if (caption) fd.append("caption", caption.slice(0, 1024));
  return tgCall(env, "sendVoice", fd);
}
async function sendTgVideoFileId(env, chatId, fileId, caption) {
  const p = new URLSearchParams({ chat_id: String(chatId), video: fileId });
  if (caption) p.set("caption", caption.slice(0, 1024));
  return tgCall(env, "sendVideo", p);
}
async function sendTgVideoBlob(env, chatId, blob, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("video", blob, "video.mp4");
  if (caption) fd.append("caption", caption.slice(0, 1024));
  return tgCall(env, "sendVideo", fd);
}
async function sendTgVideoNoteBlob(env, chatId, blob) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("video_note", blob, "video_note.mp4");
  return tgCall(env, "sendVideoNote", fd);
}
async function sendTgDocumentFileId(env, chatId, fileId, caption) {
  const p = new URLSearchParams({ chat_id: String(chatId), document: fileId });
  if (caption) p.set("caption", caption.slice(0, 1024));
  return tgCall(env, "sendDocument", p);
}
async function sendTgDocumentBlob(env, chatId, blob, filename, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("document", blob, filename || "file");
  if (caption) fd.append("caption", caption.slice(0, 1024));
  return tgCall(env, "sendDocument", fd);
}

// ============================================================
//  VK send
// ============================================================

async function sendVk(env, userId, text, keyboard, attachment) {
  const p = new URLSearchParams({
    access_token: env.VK_TOKEN,
    v: VK_API_VERSION,
    user_id: String(userId),
    random_id: randId(),
  });
  if (text) p.set("message", text);
  if (keyboard) p.set("keyboard", JSON.stringify(keyboard));
  if (attachment) p.set("attachment", attachment);
  const r = await fetch("https://api.vk.com/method/messages.send", { method: "POST", body: p });
  const d = await r.json();
  if (d.error) console.error("VK send error:", d.error);
  return !d.error;
}

async function sendMessage(env, platform, chatId, text, replyMarkup) {
  if (platform === "tg") return sendTg(env, chatId, text, replyMarkup);
  return sendVk(env, chatId, text, replyMarkup);
}

// ============================================================
//  VK name
// ============================================================

async function getVkUsername(env, userId) {
  try {
    const p = new URLSearchParams({
      access_token: env.VK_TOKEN, v: VK_API_VERSION, user_ids: String(userId),
    });
    const r = await fetch(`https://api.vk.com/method/users.get?${p}`);
    const d = await r.json();
    if (d.response && d.response[0]) {
      return ((d.response[0].first_name || "") + " " + (d.response[0].last_name || "")).trim() || "пользователь ВК";
    }
  } catch (e) { console.error("getVkUsername:", e.message); }
  return "пользователь ВК";
}

// ============================================================
//  Downloads
// ============================================================

async function downloadTgFile(env, fileId) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`);
  const d = await r.json();
  if (!d.ok || !d.result || !d.result.file_path) return null;
  const f = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${d.result.file_path}`);
  if (!f.ok) return null;
  return f.blob();
}
async function downloadUrl(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return r.blob();
  } catch { return null; }
}

// ============================================================
//  VK uploads
// ============================================================

async function uploadPhotoToVk(env, peerId, blob) {
  const s = await fetch(`https://api.vk.com/method/photos.getMessagesUploadServer?peer_id=${peerId}&access_token=${env.VK_TOKEN}&v=${VK_API_VERSION}`);
  const sd = await s.json();
  if (!sd.response || !sd.response.upload_url) return null;
  const fd = new FormData();
  fd.append("photo", blob, "photo.jpg");
  const u = await (await fetch(sd.response.upload_url, { method: "POST", body: fd })).json();
  if (!u.photo || !u.hash || u.server === undefined) return null;
  const p = new URLSearchParams({
    access_token: env.VK_TOKEN, v: VK_API_VERSION,
    server: String(u.server), photo: u.photo, hash: u.hash,
  });
  const sv = await (await fetch("https://api.vk.com/method/photos.saveMessagesPhoto", { method: "POST", body: p })).json();
  if (!sv.response || !sv.response[0]) return null;
  const ph = sv.response[0];
  return `photo${ph.owner_id}_${ph.id}`;
}

async function uploadDocToVk(env, peerId, blob, filename, asVoice) {
  const type = asVoice ? "&type=audio_message" : "";
  const s = await fetch(`https://api.vk.com/method/docs.getMessagesUploadServer?peer_id=${peerId}${type}&access_token=${env.VK_TOKEN}&v=${VK_API_VERSION}`);
  const sd = await s.json();
  if (!sd.response || !sd.response.upload_url) return null;
  const fd = new FormData();
  fd.append("file", blob, filename || "file");
  const u = await (await fetch(sd.response.upload_url, { method: "POST", body: fd })).json();
  if (!u.file) return null;
  const p = new URLSearchParams({ access_token: env.VK_TOKEN, v: VK_API_VERSION, file: u.file });
  const sv = await (await fetch("https://api.vk.com/method/docs.save", { method: "POST", body: p })).json();
  const item = sv.response && (sv.response.audio_message || sv.response.doc || sv.response[0]);
  if (!item) return null;
  return `doc${item.owner_id}_${item.id}`;
}

async function getVkVideoMp4(env, video) {
  if (video.files && (video.files.mp4_480 || video.files.mp4_360)) {
    return video.files.mp4_480 || video.files.mp4_360;
  }
  try {
    const p = new URLSearchParams({
      access_token: env.VK_TOKEN, v: VK_API_VERSION,
      owner_id: String(video.owner_id),
      videos: `${video.owner_id}_${video.id}`,
    });
    if (video.access_key) p.set("access_key", video.access_key);
    const d = await (await fetch(`https://api.vk.com/method/video.get?${p}`)).json();
    if (!d.response || !d.response.items || !d.response.items[0]) return null;
    const files = d.response.items[0].files || {};
    return files.mp4_480 || files.mp4_360 || files.mp4_240 || null;
  } catch { return null; }
}

// ============================================================
//  Bridge rendering
// ============================================================

function renderBridges(user) {
  const head = `Ваш мост: "${user.myCode}"\n\nПодключённые мосты:\n`;
  const note = `\n\nПримечание: сообщения получаешь от всех подключенных мостов, писать можешь только конкретному.`;
  if (!user.bridges || user.bridges.length === 0) {
    return head + "пока нет мостов" + note;
  }
  const lines = user.bridges.map((b, i) => {
    const mark = b.code === user.activeCode ? " [ПИШЕМ СЮДА]" : "";
    return `${i + 1}. ${b.nickname} (${platformLabel(b.platform)}), подключён${mark}`;
  });
  return head + lines.join("\n") + note;
}

function listForSelect(user) {
  const lines = user.bridges.map((b, i) => `${i + 1}. ${b.nickname} (${platformLabel(b.platform)})`);
  return `Введите число 1-${user.bridges.length} для того чтобы выбрать нового получателя или 6 чтобы вернуться:\n${lines.join("\n")}`;
}
function listForRemove(user) {
  const lines = user.bridges.map((b, i) => `${i + 1}. ${b.nickname} (${platformLabel(b.platform)})`);
  return `Введите число 1-${user.bridges.length} для удаления моста или 6 чтобы вернуться назад:\n${lines.join("\n")}`;
}

// ============================================================
//  State input
// ============================================================

const BUTTONS = new Set([
  "создать мост", "просмотреть мосты", "сменить получателя",
  "отвязать мост", "общий лимит", "/start",
]);

async function handleStateInput(env, platform, userId, chatId, text, user) {
  const lower = text.toLowerCase();
  if (BUTTONS.has(lower)) {
    user.state = "idle";
    await saveUser(env, platform, userId, user);
    return false;
  }
  const n = parseInt(text, 10);

  if (user.state === "selecting_target") {
    if (Number.isInteger(n) && n >= 1 && n <= user.bridges.length) {
      const chosen = user.bridges[n - 1];
      user.activeCode = chosen.code;
      user.state = "idle";
      await saveUser(env, platform, userId, user);
      await sendMessage(env, platform, chatId, `Получатель изменен на: ${chosen.nickname}`, kbFor(platform));
      return true;
    }
    if (n === 6) {
      user.state = "idle";
      await saveUser(env, platform, userId, user);
      await sendMessage(env, platform, chatId, "Отменено.", kbFor(platform));
      return true;
    }
    await sendMessage(env, platform, chatId, listForSelect(user), kbFor(platform));
    return true;
  }

  if (user.state === "removing_bridge") {
    if (Number.isInteger(n) && n >= 1 && n <= user.bridges.length) {
      const [removed] = user.bridges.splice(n - 1, 1);
      if (user.activeCode === removed.code) {
        user.activeCode = user.bridges.length > 0 ? user.bridges[0].code : null;
      }
      user.state = "idle";
      await saveUser(env, platform, userId, user);

      const pu = await getUser(env, removed.platform, removed.chatId);
      if (pu) {
        const before = pu.bridges.length;
        pu.bridges = pu.bridges.filter((b) => !(b.code === user.myCode));
        if (pu.bridges.length !== before) {
          if (pu.activeCode === user.myCode) {
            pu.activeCode = pu.bridges.length > 0 ? pu.bridges[0].code : null;
          }
          await saveUser(env, removed.platform, removed.chatId, pu);
          await sendMessage(env, removed.platform, removed.chatId, "собеседник отвязал мост", kbFor(removed.platform));
        }
      }

      await sendMessage(env, platform, chatId, "мост отвязан", kbFor(platform));
      return true;
    }
    if (n === 6) {
      user.state = "idle";
      await saveUser(env, platform, userId, user);
      await sendMessage(env, platform, chatId, "Отменено.", kbFor(platform));
      return true;
    }
    await sendMessage(env, platform, chatId, listForRemove(user), kbFor(platform));
    return true;
  }

  return false;
}

// ============================================================
//  Connect by code
// ============================================================

const CODE_RE = /^([a-z]{3}-\d{3}-[a-z]{3})$/i;

async function tryConnect(env, platform, userId, chatId, text, user) {
  const m = text.match(CODE_RE);
  if (!m) return false;
  const code = m[1].toLowerCase();

  if (code === user.myCode) {
    await sendMessage(env, platform, chatId, ERR_ONLY_OWN, kbFor(platform));
    return true;
  }
  if (user.bridges.some((b) => b.code === code)) {
    await sendMessage(env, platform, chatId, ERR_ALREADY_LINKED, kbFor(platform));
    return true;
  }
  if (user.bridges.length >= MAX_BRIDGES) {
    await sendMessage(env, platform, chatId, ERR_SELF_FULL, kbFor(platform));
    return true;
  }

  const owner = await getOwnerByKey(env, code);
  if (!owner) {
    await sendMessage(env, platform, chatId, ERR_CODE_NOT_FOUND, kbFor(platform));
    return true;
  }
  const ownerUser = await getUser(env, owner.platform, owner.userId);
  if (!ownerUser) {
    await sendMessage(env, platform, chatId, ERR_CODE_NOT_FOUND, kbFor(platform));
    return true;
  }
  if (ownerUser.bridges.length >= MAX_BRIDGES) {
    await sendMessage(env, platform, chatId, ERR_PARTNER_FULL, kbFor(platform));
    return true;
  }

  user.bridges.push({
    code,
    platform: owner.platform,
    chatId: owner.userId,
    nickname: ownerUser.myName || "собеседник",
  });
  if (!user.activeCode) user.activeCode = code;
  await saveUser(env, platform, userId, user);

  ownerUser.bridges.push({
    code: user.myCode,
    platform,
    chatId: userId,
    nickname: user.myName || "собеседник",
  });
  if (!ownerUser.activeCode) ownerUser.activeCode = user.myCode;
  await saveUser(env, owner.platform, owner.userId, ownerUser);

  await sendMessage(env, platform, chatId, `вы подключены к ${ownerUser.myName || "собеседнику"}`, kbFor(platform));
  await sendMessage(env, owner.platform, owner.userId, `с вами подключился ${user.myName || "пользователь"}`, kbFor(owner.platform));
  return true;
}

// ============================================================
//  Stats view
// ============================================================

async function showStats(env, platform, chatId) {
  const d = await getDaily(env);
  const text =
    `Статистика бота за сегодня (${todayStr()}):\n` +
    `- Переслано фото: ${fmtNum(d.photos || 0)} / ${fmtNum(DAILY_PHOTO_LIMIT)}\n` +
    `- Переслано файлов/медиа: ${fmtNum(d.media || 0)} шт.`;
  await sendMessage(env, platform, chatId, text, kbFor(platform));
}

// ============================================================
//  Text processor
// ============================================================

async function processText(env, platform, userId, chatId, username, rawText) {
  const text = (rawText || "").trim();
  if (!text) return;
  const lower = text.toLowerCase();
  const kb = kbFor(platform);
  const user = await ensureUser(env, platform, userId, username);

  if (lower === "/start") {
    await sendMessage(env, platform, chatId,
      `Ваш код моста: "${user.myCode}". Отправьте его собеседнику, чтобы он подключился.`, kb);
    return;
  }

  if (user.state !== "idle") {
    const handled = await handleStateInput(env, platform, userId, chatId, text, user);
    if (handled) return;
  }

  if (lower === "создать мост") {
    await sendMessage(env, platform, chatId,
      `Ваш код моста: "${user.myCode}". Отправьте его собеседнику, чтобы он подключился.`, kb);
    return;
  }
  if (lower === "просмотреть мосты") {
    await sendMessage(env, platform, chatId, renderBridges(user), kb);
    return;
  }
  if (lower === "сменить получателя") {
    if (user.bridges.length === 0) {
      await sendMessage(env, platform, chatId, "у вас пока нет мостов", kb);
      return;
    }
    user.state = "selecting_target";
    await saveUser(env, platform, userId, user);
    await sendMessage(env, platform, chatId, listForSelect(user), kb);
    return;
  }
  if (lower === "отвязать мост") {
    if (user.bridges.length === 0) {
      await sendMessage(env, platform, chatId, "у вас пока нет мостов", kb);
      return;
    }
    user.state = "removing_bridge";
    await saveUser(env, platform, userId, user);
    await sendMessage(env, platform, chatId, listForRemove(user), kb);
    return;
  }
  if (lower === "общий лимит") {
    await showStats(env, platform, chatId);
    return;
  }

  if (await tryConnect(env, platform, userId, chatId, text, user)) return;

  if (!user.activeCode) {
    await sendMessage(env, platform, chatId, ERR_NO_ACTIVE, kb);
    return;
  }
  const active = user.bridges.find((b) => b.code === user.activeCode);
  if (!active) {
    await sendMessage(env, platform, chatId, ERR_NO_ACTIVE, kb);
    return;
  }
  const prefix = `[${user.myName} | ${platformLabel(platform)}]: `;
  await sendMessage(env, active.platform, active.chatId, prefix + text);
  await sendMessage(env, platform, chatId, OK_DELIVERED);
}

// ============================================================
//  TG media forwarding
// ============================================================

async function forwardTgPhoto(env, msg, active, chatId, user) {
  let fileId;
  let isDoc = false;
  if (msg.photo && msg.photo.length > 0) {
    const arr = msg.photo;
    fileId = (arr.length >= 2 ? arr[arr.length - 2] : arr[arr.length - 1]).file_id;
  } else if (msg.document) {
    fileId = msg.document.file_id;
    isDoc = true;
  } else return;

  const captionText = makeCaption(user.myName, "tg", msg.caption);
  if (!(await tryConsumePhoto(env))) {
    await sendMessage(env, "tg", chatId, ERR_LIMIT, TG_KEYBOARD);
    return;
  }
  let ok = false;
  try {
    if (active.platform === "tg") {
      ok = await sendTgPhotoFileId(env, active.chatId, fileId, captionText);
    } else {
      const blob = await downloadTgFile(env, fileId);
      if (!blob) { await refundPhoto(env); await sendMessage(env, "tg", chatId, ERR_DOWNLOAD, TG_KEYBOARD); return; }
      const att = await uploadPhotoToVk(env, active.chatId, blob);
      if (!att) { await refundPhoto(env); await sendMessage(env, "tg", chatId, ERR_FORWARD, TG_KEYBOARD); return; }
      ok = await sendVk(env, active.chatId, captionText, null, att);
    }
  } catch (e) { console.error("fwdTgPhoto:", e.message); ok = false; }
  if (!ok) { await refundPhoto(env); await sendMessage(env, "tg", chatId, ERR_FORWARD, TG_KEYBOARD); return; }
  await sendMessage(env, "tg", chatId, OK_DELIVERED, TG_KEYBOARD);
}

async function forwardTgVoice(env, msg, voice, active, chatId, user) {
  if ((voice.duration || 0) > MAX_VOICE_DURATION || (voice.file_size || 0) > MAX_VOICE_BYTES) {
    await sendMessage(env, "tg", chatId, ERR_VOICE_LIMIT, TG_KEYBOARD);
    return;
  }
  const captionText = makeCaption(user.myName, "tg", "");
  let ok = false;
  try {
    if (active.platform === "tg") {
      ok = await sendTgVoiceFileId(env, active.chatId, voice.file_id, captionText);
    } else {
      const blob = await downloadTgFile(env, voice.file_id);
      if (!blob) { await sendMessage(env, "tg", chatId, ERR_DOWNLOAD, TG_KEYBOARD); return; }
      const att = await uploadDocToVk(env, active.chatId, blob, "voice.ogg", true);
      if (!att) { await sendMessage(env, "tg", chatId, ERR_FORWARD, TG_KEYBOARD); return; }
      ok = await sendVk(env, active.chatId, captionText, null, att);
    }
  } catch (e) { console.error("fwdTgVoice:", e.message); ok = false; }
  if (!ok) { await sendMessage(env, "tg", chatId, ERR_FORWARD, TG_KEYBOARD); return; }
  await bumpMedia(env);
  await sendMessage(env, "tg", chatId, OK_DELIVERED, TG_KEYBOARD);
}

async function forwardTgVideo(env, msg, video, active, chatId, user, isNote) {
  const duration = video.duration || 0;
  const size = video.file_size || 0;
  if (duration > MAX_VIDEO_DURATION) {
    await sendMessage(env, "tg", chatId, ERR_VIDEO_LIMIT, TG_KEYBOARD);
    return;
  }
  const maxAllowed = Math.min(MAX_VIDEO_BYTES, Math.max(VIDEO_MIN_BYTES, duration * VIDEO_BYTES_PER_SEC));
  if (size > maxAllowed) {
    await sendMessage(env, "tg", chatId, ERR_VIDEO_LIMIT, TG_KEYBOARD);
    return;
  }
  const captionText = makeCaption(user.myName, "tg", msg.caption);
  let ok = false;
  try {
    if (active.platform === "tg") {
      if (isNote) {
        const p = new URLSearchParams({ chat_id: String(active.chatId), video_note: video.file_id });
        ok = await tgCall(env, "sendVideoNote", p);
      } else {
        ok = await sendTgVideoFileId(env, active.chatId, video.file_id, captionText);
      }
    } else {
      const blob = await downloadTgFile(env, video.file_id);
      if (!blob) { await sendMessage(env, "tg", chatId, ERR_DOWNLOAD, TG_KEYBOARD); return; }
      const att = await uploadDocToVk(env, active.chatId, blob, "video.mp4", false);
      if (!att) { await sendMessage(env, "tg", chatId, ERR_FORWARD, TG_KEYBOARD); return; }
      ok = await sendVk(env, active.chatId, captionText, null, att);
    }
  } catch (e) { console.error("fwdTgVideo:", e.message); ok = false; }
  if (!ok) { await sendMessage(env, "tg", chatId, ERR_FORWARD, TG_KEYBOARD); return; }
  await bumpMedia(env);
  await sendMessage(env, "tg", chatId, OK_DELIVERED, TG_KEYBOARD);
}

async function forwardTgDocument(env, msg, doc, active, chatId, user) {
  const mime = doc.mime_type || "";
  if (mime === "application/x-tgsticker") return;
  if ((doc.file_size || 0) > MAX_DOC_BYTES) {
    await sendMessage(env, "tg", chatId, ERR_DOC_TOO_BIG, TG_KEYBOARD);
    return;
  }
  const captionText = makeCaption(user.myName, "tg", msg.caption);
  const filename = doc.file_name || "file";
  let ok = false;
  try {
    if (active.platform === "tg") {
      ok = await sendTgDocumentFileId(env, active.chatId, doc.file_id, captionText);
    } else {
      const blob = await downloadTgFile(env, doc.file_id);
      if (!blob) { await sendMessage(env, "tg", chatId, ERR_DOWNLOAD, TG_KEYBOARD); return; }
      const att = await uploadDocToVk(env, active.chatId, blob, filename, false);
      if (!att) { await sendMessage(env, "tg", chatId, ERR_VK_BLOCKED, TG_KEYBOARD); return; }
      ok = await sendVk(env, active.chatId, captionText, null, att);
    }
  } catch (e) { console.error("fwdTgDoc:", e.message); ok = false; }
  if (!ok) { await sendMessage(env, "tg", chatId, ERR_FORWARD, TG_KEYBOARD); return; }
  await bumpMedia(env);
  await sendMessage(env, "tg", chatId, OK_DELIVERED, TG_KEYBOARD);
}

async function processTgMedia(env, msg, userId, chatId, username) {
  const user = await ensureUser(env, "tg", userId, username);
  if (!user.activeCode) { await sendMessage(env, "tg", chatId, ERR_NO_ACTIVE, TG_KEYBOARD); return; }
  const active = user.bridges.find((b) => b.code === user.activeCode);
  if (!active) { await sendMessage(env, "tg", chatId, ERR_NO_ACTIVE, TG_KEYBOARD); return; }

  if (msg.photo && msg.photo.length > 0) { await forwardTgPhoto(env, msg, active, chatId, user); return; }
  if (msg.voice)  { await forwardTgVoice(env, msg, msg.voice, active, chatId, user); return; }
  if (msg.video)  { await forwardTgVideo(env, msg, msg.video, active, chatId, user, false); return; }
  if (msg.video_note) { await forwardTgVideo(env, msg, msg.video_note, active, chatId, user, true); return; }
  if (msg.document) {
    const mime = msg.document.mime_type || "";
    if (mime.startsWith("image/")) {
      await forwardTgPhoto(env, msg, active, chatId, user);
    } else {
      await forwardTgDocument(env, msg, msg.document, active, chatId, user);
    }
    return;
  }
}

// ============================================================
//  VK media forwarding
// ============================================================

async function forwardVkPhoto(env, msg, att, active, chatId, user) {
  const photo = att.photo;
  const captionText = makeCaption(user.myName, "vk", msg.text);
  if (!(await tryConsumePhoto(env))) {
    await sendMessage(env, "vk", chatId, ERR_LIMIT, VK_KEYBOARD); return;
  }
  let ok = false;
  try {
    if (active.platform === "vk") {
      let ref = `photo${photo.owner_id}_${photo.id}`;
      if (photo.access_key) ref += `_${photo.access_key}`;
      ok = await sendVk(env, active.chatId, captionText, null, ref);
    } else {
      const sizes = photo.sizes || [];
      if (sizes.length === 0) { await refundPhoto(env); await sendMessage(env, "vk", chatId, ERR_FORWARD, VK_KEYBOARD); return; }
      let chosen = sizes.find((s) => s.type === "y") || sizes.find((s) => s.type === "x");
      if (!chosen) chosen = sizes.reduce((m, s) => (s.width * s.height > m.width * m.height ? s : m), sizes[0]);
      ok = await sendTgPhotoUrl(env, active.chatId, chosen.url, captionText);
    }
  } catch (e) { console.error("fwdVkPhoto:", e.message); ok = false; }
  if (!ok) { await refundPhoto(env); await sendMessage(env, "vk", chatId, ERR_FORWARD, VK_KEYBOARD); return; }
  await sendMessage(env, "vk", chatId, OK_DELIVERED, VK_KEYBOARD);
}

async function forwardVkVoice(env, msg, am, active, chatId, user) {
  if ((am.duration || 0) > MAX_VOICE_DURATION) {
    await sendMessage(env, "vk", chatId, ERR_VOICE_LIMIT, VK_KEYBOARD); return;
  }
  const captionText = makeCaption(user.myName, "vk", "");
  let ok = false;
  try {
    if (active.platform === "vk") {
      const ref = `doc${am.owner_id}_${am.id}` + (am.access_key ? `_${am.access_key}` : "");
      ok = await sendVk(env, active.chatId, captionText, null, ref);
    } else {
      const url = am.link_ogg || am.link_mp3;
      if (!url) { await sendMessage(env, "vk", chatId, ERR_FORWARD, VK_KEYBOARD); return; }
      const blob = await downloadUrl(url);
      if (!blob) { await sendMessage(env, "vk", chatId, ERR_DOWNLOAD, VK_KEYBOARD); return; }
      ok = await sendTgVoiceBlob(env, active.chatId, blob, captionText);
    }
  } catch (e) { console.error("fwdVkVoice:", e.message); ok = false; }
  if (!ok) { await sendMessage(env, "vk", chatId, ERR_FORWARD, VK_KEYBOARD); return; }
  await bumpMedia(env);
  await sendMessage(env, "vk", chatId, OK_DELIVERED, VK_KEYBOARD);
}

async function forwardVkVideo(env, msg, v, active, chatId, user) {
  if ((v.duration || 0) > MAX_VIDEO_DURATION) {
    await sendMessage(env, "vk", chatId, ERR_VIDEO_LIMIT, VK_KEYBOARD); return;
  }
  const captionText = makeCaption(user.myName, "vk", msg.text);
  let ok = false;
  try {
    if (active.platform === "vk") {
      let ref = `video${v.owner_id}_${v.id}`;
      if (v.access_key) ref += `_${v.access_key}`;
      ok = await sendVk(env, active.chatId, captionText, null, ref);
    } else {
      const url = await getVkVideoMp4(env, v);
      if (!url) { await sendMessage(env, "vk", chatId, ERR_FORWARD, VK_KEYBOARD); return; }
      const blob = await downloadUrl(url);
      if (!blob) { await sendMessage(env, "vk", chatId, ERR_DOWNLOAD, VK_KEYBOARD); return; }
      if ((v.width || 0) > 0 && v.width === v.height) {
        ok = await sendTgVideoNoteBlob(env, active.chatId, blob);
      } else {
        ok = await sendTgVideoBlob(env, active.chatId, blob, captionText);
      }
    }
  } catch (e) { console.error("fwdVkVideo:", e.message); ok = false; }
  if (!ok) { await sendMessage(env, "vk", chatId, ERR_FORWARD, VK_KEYBOARD); return; }
  await bumpMedia(env);
  await sendMessage(env, "vk", chatId, OK_DELIVERED, VK_KEYBOARD);
}

async function forwardVkDocument(env, msg, doc, active, chatId, user) {
  if ((doc.size || 0) > MAX_DOC_BYTES) {
    await sendMessage(env, "vk", chatId, ERR_DOC_TOO_BIG, VK_KEYBOARD); return;
  }
  const captionText = makeCaption(user.myName, "vk", msg.text);
  const filename = doc.title || "file";
  let ok = false;
  try {
    if (active.platform === "vk") {
      let ref = `doc${doc.owner_id}_${doc.id}`;
      if (doc.access_key) ref += `_${doc.access_key}`;
      ok = await sendVk(env, active.chatId, captionText, null, ref);
    } else {
      // Скачиваем чтобы сохранить оригинальное имя файла
      const blob = await downloadUrl(doc.url);
      if (!blob) { await sendMessage(env, "vk", chatId, ERR_DOWNLOAD, VK_KEYBOARD); return; }
      ok = await sendTgDocumentBlob(env, active.chatId, blob, filename, captionText);
    }
  } catch (e) { console.error("fwdVkDoc:", e.message); ok = false; }
  if (!ok) { await sendMessage(env, "vk", chatId, ERR_FORWARD, VK_KEYBOARD); return; }
  await bumpMedia(env);
  await sendMessage(env, "vk", chatId, OK_DELIVERED, VK_KEYBOARD);
}

async function processVkMedia(env, msg, userId, chatId, username) {
  const user = await ensureUser(env, "vk", userId, username);
  if (!user.activeCode) { await sendMessage(env, "vk", chatId, ERR_NO_ACTIVE, VK_KEYBOARD); return; }
  const active = user.bridges.find((b) => b.code === user.activeCode);
  if (!active) { await sendMessage(env, "vk", chatId, ERR_NO_ACTIVE, VK_KEYBOARD); return; }

  const atts = msg.attachments || [];
  const photos = atts.filter((a) => a.type === "photo");
  if (photos.length > 1) {
    await sendMessage(env, "vk", chatId, ERR_ALBUM, VK_KEYBOARD); return;
  }
  for (const a of atts) {
    if (a.type === "photo")        { await forwardVkPhoto(env, msg, a, active, chatId, user); return; }
    if (a.type === "audio_message"){ await forwardVkVoice(env, msg, a.audio_message, active, chatId, user); return; }
    if (a.type === "video")        { await forwardVkVideo(env, msg, a.video, active, chatId, user); return; }
    if (a.type === "doc")          { await forwardVkDocument(env, msg, a.doc, active, chatId, user); return; }
  }
}

// ============================================================
//  Webhook handlers
// ============================================================

async function handleTgUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  const from = msg.from;
  const userId = from.id;
  const chatId = msg.chat.id;
  const username = from.username ? "@" + from.username : (from.first_name || "пользователь");

  if (msg.media_group_id) {
    const dk = `album:${chatId}:${msg.media_group_id}`;
    if (!(await env.BOT_KV.get(dk))) {
      await env.BOT_KV.put(dk, "1", { expirationTtl: 60 });
      await sendMessage(env, "tg", chatId, ERR_ALBUM, TG_KEYBOARD);
    }
    return;
  }
  if (msg.sticker) return;

  const hasMedia = !!(msg.photo || msg.voice || msg.video || msg.video_note || msg.document);
  if (hasMedia) {
    await processTgMedia(env, msg, userId, chatId, username);
  } else if (typeof msg.text === "string") {
    await processText(env, "tg", userId, chatId, username, msg.text);
  }
}

async function handleVkUpdate(body, env) {
  if (env.VK_SECRET && body.secret !== env.VK_SECRET) return;
  if (body.type !== "message_new") return;
  const msg = body.object && body.object.message;
  if (!msg) return;
  const userId = msg.from_id;
  const chatId = msg.peer_id || userId;
  const username = await getVkUsername(env, userId);

  const hasMedia = msg.attachments && msg.attachments.length > 0;
  if (hasMedia) {
    await processVkMedia(env, msg, userId, chatId, username);
  } else if (typeof msg.text === "string" && msg.text.trim()) {
    await processText(env, "vk", userId, chatId, username, msg.text);
  }
}

// ============================================================
//  Worker entry
// ============================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") return new Response("Bot is running", { status: 200 });
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    let body;
    try { body = await request.json(); } catch { return new Response("OK", { status: 200 }); }

    if (body && body.type === "confirmation") {
      return new Response(env.VK_CONFIRMATION_CODE || "", {
        status: 200, headers: { "Content-Type": "text/plain" },
      });
    }

    if (body && body.update_id) {
      ctx.waitUntil(handleTgUpdate(body, env).catch((e) => console.error("TG:", e.message, e.stack)));
    } else if (body && body.type && body.group_id) {
      ctx.waitUntil(handleVkUpdate(body, env).catch((e) => console.error("VK:", e.message, e.stack)));
    }

    return new Response("OK", { status: 200 });
  },
};
