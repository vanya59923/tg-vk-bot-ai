// ============ КЛАВИАТУРЫ ============

const TG_KEYBOARD = {
  keyboard: [
    [{ text: "перевыпустить мост" }],
    [{ text: "просмотреть мост" }],
    [{ text: "отвязать мост" }],
  ],
  resize_keyboard: true,
};

const TG_CONFIRM_KEYBOARD = {
  keyboard: [[{ text: "да" }, { text: "нет" }]],
  resize_keyboard: true,
};

const VK_KEYBOARD = {
  one_time: false,
  buttons: [
    [{ action: { type: "text", label: "перевыпустить мост" }, color: "primary" }],
    [{ action: { type: "text", label: "просмотреть мост" }, color: "primary" }],
    [{ action: { type: "text", label: "отвязать мост" }, color: "negative" }],
  ],
};

const VK_CONFIRM_KEYBOARD = {
  one_time: false,
  buttons: [
    [
      { action: { type: "text", label: "да" }, color: "positive" },
      { action: { type: "text", label: "нет" }, color: "negative" },
    ],
  ],
};

const DAILY_PHOTO_LIMIT = 50;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const CONFIRM_TTL_MS = 2 * 60 * 1000;

const ERR_FORWARD = "не удалось переслать фото, попробуйте ещё раз";
const ERR_DOWNLOAD = "не удалось скачать фото, попробуйте ещё раз";
const ERR_TOO_BIG = "файл слишком большой, попробуйте ещё раз с меньшим фото";
const ERR_DOC_TOO_BIG = "файл больше 4 мб, пришлите как обычное фото";
const ERR_ALBUM = "альбомы не поддерживаются, пришлите фото по одному";
const ERR_LIMIT = "дневной лимит фото закончился, попробуйте завтра";
const ERR_ONLY_PHOTO = "можно отправлять только фотографии";
const ERR_NO_PARTNER = "у вас нет собеседника, отправьте код подключения или поделитесь своим";
const ERR_NO_START = "нажмите /start для регистрации";
const ERR_PARTNER_LEFT = "собеседник отвязал мост";
const OK_DELIVERED = "сообщение доставлено";
const CONFIRM_PROMPT = "вы точно хотите сделать это?";

// ============ ГЕНЕРАЦИЯ КЛЮЧА ============

function randomLetter() {
  return String.fromCharCode(97 + Math.floor(Math.random() * 26));
}
function randomDigit() {
  return String(Math.floor(Math.random() * 10));
}

function generateKeyCandidate() {
  return (
    randomLetter() + randomLetter() + randomLetter() + "-" +
    randomDigit() + randomDigit() + randomDigit() + "-" +
    randomLetter() + randomLetter() + randomLetter()
  );
}

async function generateUniqueKey(env) {
  while (true) {
    const key = generateKeyCandidate();
    const existing = await env.BOT_KV.get(`bridgekey:${key}`);
    if (existing === null) return key;
  }
}

// ============ KV ХЕЛПЕРЫ ============

async function getBridge(env, platform, userId) {
  return await env.BOT_KV.get(`bridge:${platform}:${userId}`, "json");
}
async function saveBridge(env, platform, userId, bridge) {
  await env.BOT_KV.put(`bridge:${platform}:${userId}`, JSON.stringify(bridge));
}
async function getOwnerByKey(env, key) {
  return await env.BOT_KV.get(`bridgekey:${key}`, "json");
}
async function saveOwnerByKey(env, key, owner) {
  await env.BOT_KV.put(`bridgekey:${key}`, JSON.stringify(owner));
}
async function deleteOwnerByKey(env, key) {
  if (key) {
    await env.BOT_KV.delete(`bridgekey:${key}`);
  }
}

// ============ ДНЕВНОЙ ЛИМИТ ============

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function consumePhotoQuota(env) {
  const key = `photo_count:${todayKey()}`;
  const countStr = await env.BOT_KV.get(key);
  const count = countStr ? parseInt(countStr, 10) : 0;
  if (count >= DAILY_PHOTO_LIMIT) return false;
  await env.BOT_KV.put(key, String(count + 1), { expirationTtl: 90000 });
  return true;
}

async function refundPhotoQuota(env) {
  try {
    const key = `photo_count:${todayKey()}`;
    const countStr = await env.BOT_KV.get(key);
    const count = countStr ? parseInt(countStr, 10) : 0;
    if (count > 0) {
      await env.BOT_KV.put(key, String(count - 1), { expirationTtl: 90000 });
    }
  } catch (e) {
    console.error("REFUND QUOTA ERROR:", e.message);
  }
}

// ============ ОТПРАВКА ============

async function sendTg(env, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendTgPhotoFileId(env, chatId, fileId, caption) {
  const params = new URLSearchParams({
    chat_id: String(chatId),
    photo: fileId,
  });
  if (caption) params.set("caption", caption.slice(0, 1024));
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: params,
  });
  const data = await res.json();
  return data.ok === true;
}

async function sendTgPhotoBlob(env, chatId, blob, caption) {
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  formData.append("photo", blob, "photo.jpg");
  if (caption) formData.append("caption", caption.slice(0, 1024));
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.ok === true;
}

async function sendTgPhotoUrl(env, chatId, url, caption) {
  const params = new URLSearchParams({
    chat_id: String(chatId),
    photo: url,
  });
  if (caption) params.set("caption", caption.slice(0, 1024));
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: params,
  });
  const data = await res.json();
  return data.ok === true;
}

async function sendVk(env, userId, text, keyboard, attachment) {
  const params = new URLSearchParams({
    access_token: env.VK_TOKEN,
    v: "5.131",
    user_id: String(userId),
    random_id: String(Math.floor(Math.random() * 2147483647)),
  });
  if (text) params.set("message", text);
  if (keyboard) params.set("keyboard", JSON.stringify(keyboard));
  if (attachment) params.set("attachment", attachment);
  const res = await fetch("https://api.vk.com/method/messages.send", {
    method: "POST",
    body: params,
  });
  const data = await res.json();
  return !data.error;
}

async function sendMessage(env, platform, chatId, text, replyMarkup) {
  if (platform === "tg") return await sendTg(env, chatId, text, replyMarkup);
  if (platform === "vk") return await sendVk(env, chatId, text, replyMarkup);
  return false;
}

// ============ VK USERNAME ============

async function getVkUsername(env, userId) {
  try {
    const params = new URLSearchParams({
      access_token: env.VK_TOKEN,
      v: "5.131",
      user_ids: String(userId),
    });
    const res = await fetch("https://api.vk.com/method/users.get?" + params);
    const data = await res.json();
    if (data.response && data.response[0]) {
      const u = data.response[0];
      return (u.first_name + " " + u.last_name).trim();
    }
  } catch (e) {}
  return "пользователь vk";
}

// ============ VK UPLOAD ============

async function uploadPhotoToVk(env, peerId, blob) {
  const serverRes = await fetch(
    `https://api.vk.com/method/photos.getMessagesUploadServer?peer_id=${peerId}&access_token=${env.VK_TOKEN}&v=5.131`
  );
  const serverData = await serverRes.json();
  if (!serverData.response || !serverData.response.upload_url) {
    return null;
  }

  const formData = new FormData();
  formData.append("photo", blob, "photo.jpg");
  const uploadRes = await fetch(serverData.response.upload_url, {
    method: "POST",
    body: formData,
  });
  const uploaded = await uploadRes.json();
  if (!uploaded.photo || !uploaded.hash || uploaded.server === undefined) {
    return null;
  }

  const saveParams = new URLSearchParams({
    access_token: env.VK_TOKEN,
    v: "5.131",
    server: String(uploaded.server),
    photo: uploaded.photo,
    hash: uploaded.hash,
  });
  const saveRes = await fetch("https://api.vk.com/method/photos.saveMessagesPhoto", {
    method: "POST",
    body: saveParams,
  });
  const saved = await saveRes.json();
  if (!saved.response || !saved.response[0]) {
    return null;
  }

  const photo = saved.response[0];
  return `photo${photo.owner_id}_${photo.id}`;
}

// ============ ХЕЛПЕР ОТВЯЗКИ ПАРТНЁРА ============

async function detachPartnerIfLinked(env, myBridge, myPlatform, myUserId) {
  if (!myBridge.partnerPlatform || myBridge.partnerId === null) return;

  const partnerPlatform = myBridge.partnerPlatform;
  const partnerId = myBridge.partnerId;

  myBridge.partnerPlatform = null;
  myBridge.partnerId = null;
  myBridge.partnerName = null;

  const partnerBridge = await getBridge(env, partnerPlatform, partnerId);
  if (
    partnerBridge &&
    partnerBridge.partnerPlatform === myPlatform &&
    String(partnerBridge.partnerId) === String(myUserId)
  ) {
    partnerBridge.partnerPlatform = null;
    partnerBridge.partnerId = null;
    partnerBridge.partnerName = null;
    await saveBridge(env, partnerPlatform, partnerId, partnerBridge);
    await sendMessage(
      env,
      partnerPlatform,
      partnerId,
      ERR_PARTNER_LEFT,
      partnerPlatform === "tg" ? TG_KEYBOARD : VK_KEYBOARD
    );
  }
}

// ============ TG MEDIA HANDLER ============

async function handleTgMedia(update, env) {
  const msg = update.message;
  const chatId = msg.chat.id;
  try {
    const from = msg.from;
    if (!from) return;

    const userId = from.id;
    const username = from.username ? "@" + from.username : (from.first_name || "пользователь");
    const caption = (msg.caption || "").trim();
    const captionText = caption ? `фото от ${username}: ${caption}` : `фото от ${username}`;

    if (msg.media_group_id) {
      const dedupKey = `album:${chatId}:${msg.media_group_id}`;
      const already = await env.BOT_KV.get(dedupKey);
      if (!already) {
        await env.BOT_KV.put(dedupKey, "1", { expirationTtl: 60 });
        await sendTg(env, chatId, ERR_ALBUM);
      }
      return;
    }

    const myBridge = await getBridge(env, "tg", userId);
    if (!myBridge) {
      await sendTg(env, chatId, ERR_NO_START);
      return;
    }

    // Обновляем собственное имя отправителя
    if (myBridge.myName !== username) {
      myBridge.myName = username;
      await saveBridge(env, "tg", userId, myBridge);
    }

    if (!myBridge.partnerPlatform || myBridge.partnerId === null) {
      await sendTg(env, chatId, ERR_NO_PARTNER);
      return;
    }

    const partnerBridge = await getBridge(env, myBridge.partnerPlatform, myBridge.partnerId);
    if (
      !partnerBridge ||
      partnerBridge.partnerPlatform !== "tg" ||
      String(partnerBridge.partnerId) !== String(userId)
    ) {
      await sendTg(env, chatId, ERR_PARTNER_LEFT);
      return;
    }

    let fileId = null;
    let isDocument = false;
    if (msg.document) {
      if (!msg.document.mime_type || !msg.document.mime_type.startsWith("image/")) {
        await sendTg(env, chatId, ERR_ONLY_PHOTO);
        return;
      }
      if (msg.document.file_size && msg.document.file_size > MAX_DOCUMENT_BYTES) {
        await sendTg(env, chatId, ERR_DOC_TOO_BIG);
        return;
      }
      fileId = msg.document.file_id;
      isDocument = true;
    } else if (msg.photo && msg.photo.length > 0) {
      const photos = msg.photo;
      const chosen = photos.length >= 2 ? photos[photos.length - 2] : photos[photos.length - 1];
      fileId = chosen.file_id;
    }

    if (!fileId) return;

    if (!(await consumePhotoQuota(env))) {
      await sendTg(env, chatId, ERR_LIMIT);
      return;
    }

    const partnerPlatform = myBridge.partnerPlatform;
    const partnerId = myBridge.partnerId;

    if (partnerPlatform === "tg" && !isDocument) {
      const ok = await sendTgPhotoFileId(env, partnerId, fileId, captionText);
      if (!ok) {
        await refundPhotoQuota(env);
        await sendTg(env, chatId, ERR_FORWARD);
        return;
      }
      await sendTg(env, chatId, OK_DELIVERED);
      return;
    }

    const getFileRes = await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileData = await getFileRes.json();
    if (!fileData.ok || !fileData.result || !fileData.result.file_path) {
      await refundPhotoQuota(env);
      await sendTg(env, chatId, ERR_DOWNLOAD);
      return;
    }

    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileData.result.file_path}`
    );
    if (!fileRes.ok) {
      await refundPhotoQuota(env);
      await sendTg(env, chatId, ERR_DOWNLOAD);
      return;
    }
    const blob = await fileRes.blob();

    if (blob.size > MAX_BLOB_BYTES) {
      await refundPhotoQuota(env);
      await sendTg(env, chatId, ERR_TOO_BIG);
      return;
    }

    if (partnerPlatform === "tg") {
      const ok = await sendTgPhotoBlob(env, partnerId, blob, captionText);
      if (!ok) {
        await refundPhotoQuota(env);
        await sendTg(env, chatId, ERR_FORWARD);
        return;
      }
      await sendTg(env, chatId, OK_DELIVERED);
    } else if (partnerPlatform === "vk") {
      const attachment = await uploadPhotoToVk(env, partnerId, blob);
      if (!attachment) {
        await refundPhotoQuota(env);
        await sendTg(env, chatId, ERR_FORWARD);
        return;
      }
      const ok = await sendVk(env, partnerId, captionText, null, attachment);
      if (!ok) {
        await refundPhotoQuota(env);
        await sendTg(env, chatId, ERR_FORWARD);
        return;
      }
      await sendTg(env, chatId, OK_DELIVERED);
    }
  } catch (e) {
    console.error("TG MEDIA ERROR:", e.message, e.stack);
    try { await refundPhotoQuota(env); } catch (e1) {}
    try { await sendTg(env, chatId, ERR_FORWARD); } catch (e2) {}
  }
}

// ============ VK MEDIA HANDLER ============

async function handleVkMedia(body, env) {
  const msg = body.object.message;
  const userId = msg.from_id;
  try {
    const username = await getVkUsername(env, userId);
    const caption = (msg.text || "").trim();
    const captionText = caption ? `фото от ${username}: ${caption}` : `фото от ${username}`;

    const photoAttachments = (msg.attachments || []).filter(a => a.type === "photo");
    if (photoAttachments.length === 0) return;

    if (photoAttachments.length > 1) {
      await sendVk(env, userId, ERR_ALBUM);
      return;
    }

    const myBridge = await getBridge(env, "vk", userId);
    if (!myBridge) {
      await sendVk(env, userId, ERR_NO_START);
      return;
    }

    // Обновляем собственное имя отправителя
    if (myBridge.myName !== username) {
      myBridge.myName = username;
      await saveBridge(env, "vk", userId, myBridge);
    }

    if (!myBridge.partnerPlatform || myBridge.partnerId === null) {
      await sendVk(env, userId, ERR_NO_PARTNER);
      return;
    }

    const partnerBridge = await getBridge(env, myBridge.partnerPlatform, myBridge.partnerId);
    if (
      !partnerBridge ||
      partnerBridge.partnerPlatform !== "vk" ||
      String(partnerBridge.partnerId) !== String(userId)
    ) {
      await sendVk(env, userId, ERR_PARTNER_LEFT);
      return;
    }

    if (!(await consumePhotoQuota(env))) {
      await sendVk(env, userId, ERR_LIMIT);
      return;
    }

    const photo = photoAttachments[0].photo;
    const sizes = photo.sizes || [];
    if (sizes.length === 0) {
      await refundPhotoQuota(env);
      await sendVk(env, userId, ERR_FORWARD);
      return;
    }
    let chosen = sizes.find(s => s.type === "y") || sizes.find(s => s.type === "x");
    if (!chosen) {
      chosen = sizes.reduce((max, s) => (s.width * s.height > max.width * max.height ? s : max), sizes[0]);
    }
    const url = chosen.url;

    const partnerPlatform = myBridge.partnerPlatform;
    const partnerId = myBridge.partnerId;

    if (partnerPlatform === "tg") {
      const ok = await sendTgPhotoUrl(env, partnerId, url, captionText);
      if (!ok) {
        await refundPhotoQuota(env);
        await sendVk(env, userId, ERR_FORWARD);
        return;
      }
      await sendVk(env, userId, OK_DELIVERED);
    } else if (partnerPlatform === "vk") {
      let attachment = `photo${photo.owner_id}_${photo.id}`;
      if (photo.access_key) attachment += `_${photo.access_key}`;
      const ok = await sendVk(env, partnerId, captionText, null, attachment);
      if (!ok) {
        await refundPhotoQuota(env);
        await sendVk(env, userId, ERR_FORWARD);
        return;
      }
      await sendVk(env, userId, OK_DELIVERED);
    }
  } catch (e) {
    console.error("VK MEDIA ERROR:", e.message, e.stack);
    try { await refundPhotoQuota(env); } catch (e1) {}
    try { await sendVk(env, userId, ERR_FORWARD); } catch (e2) {}
  }
}

// ============ ТЕКСТОВАЯ ЛОГИКА ============

async function processMessage(msg, env) {
  const { platform, userId, chatId, username, text } = msg;
  const keyboard = platform === "tg" ? TG_KEYBOARD : VK_KEYBOARD;
  const confirmKeyboard = platform === "tg" ? TG_CONFIRM_KEYBOARD : VK_CONFIRM_KEYBOARD;
  const normalized = text.toLowerCase();

  let myBridge = await getBridge(env, platform, userId);

  // ---- Обработка подтверждения (да / нет) ----
  if (myBridge && myBridge.pendingAction) {
    const isExpired =
      myBridge.pendingExpiresAt && Date.now() > myBridge.pendingExpiresAt;
    const action = myBridge.pendingAction;

    if (isExpired) {
      delete myBridge.pendingAction;
      delete myBridge.pendingExpiresAt;
      await saveBridge(env, platform, userId, myBridge);
    } else if (normalized === "да") {
      delete myBridge.pendingAction;
      delete myBridge.pendingExpiresAt;
      myBridge.myName = username;

      if (action === "reissue") {
        const oldKey = myBridge.key;
        await detachPartnerIfLinked(env, myBridge, platform, userId);
        await deleteOwnerByKey(env, oldKey);

        const newKey = await generateUniqueKey(env);
        myBridge.key = newKey;
        await saveBridge(env, platform, userId, myBridge);
        await saveOwnerByKey(env, newKey, { platform, userId });

        await sendMessage(
          env,
          platform,
          chatId,
          `мост перевыпущен, ваш новый код подключения: "${newKey}", передайте его собеседнику`,
          keyboard
        );
        return;
      }

      if (action === "unlink") {
        if (myBridge.partnerId === null || !myBridge.partnerPlatform) {
          await saveBridge(env, platform, userId, myBridge);
          await sendMessage(env, platform, chatId, "у вас нет собеседника", keyboard);
          return;
        }
        await detachPartnerIfLinked(env, myBridge, platform, userId);
        await saveBridge(env, platform, userId, myBridge);
        await sendMessage(env, platform, chatId, "мост отвязан", keyboard);
        return;
      }
    } else if (normalized === "нет") {
      delete myBridge.pendingAction;
      delete myBridge.pendingExpiresAt;
      myBridge.myName = username;
      await saveBridge(env, platform, userId, myBridge);
      await sendMessage(env, platform, chatId, "действие отменено", keyboard);
      return;
    } else {
      // Если пользователь написал что-то другое вместо да/нет — сбрасываем ожидание и обрабатываем сообщение дальше
      delete myBridge.pendingAction;
      delete myBridge.pendingExpiresAt;
      await saveBridge(env, platform, userId, myBridge);
    }
  }

  const keyMatch = text.match(/[a-z]{3}-\d{3}-[a-z]{3}/i);
  const isCommand =
    normalized === "/start" ||
    normalized === "перевыпустить мост" ||
    normalized === "просмотреть мост" ||
    normalized === "отвязать мост";
  const isCodeEntry = !isCommand && keyMatch !== null;

  // ---- /start ----
  if (normalized === "/start") {
    if (!myBridge) {
      const key = await generateUniqueKey(env);
      myBridge = {
        key,
        myName: username,
        partnerPlatform: null,
        partnerId: null,
        partnerName: null,
      };
      await saveBridge(env, platform, userId, myBridge);
      await saveOwnerByKey(env, key, { platform, userId });
      await sendMessage(
        env,
        platform,
        chatId,
        `ваш код подключения: "${key}", передайте его собеседнику, или отправьте чужой код для подключения`,
        keyboard
      );
    } else {
      myBridge.myName = username;
      let actualPartnerName = null;
      if (myBridge.partnerPlatform && myBridge.partnerId !== null) {
        const partnerBridge = await getBridge(env, myBridge.partnerPlatform, myBridge.partnerId);
        if (
          partnerBridge &&
          partnerBridge.partnerPlatform === platform &&
          String(partnerBridge.partnerId) === String(userId)
        ) {
          actualPartnerName = partnerBridge.myName || myBridge.partnerName || "собеседник";
          myBridge.partnerName = actualPartnerName;
        }
      }
      await saveBridge(env, platform, userId, myBridge);

      if (actualPartnerName) {
        await sendMessage(
          env,
          platform,
          chatId,
          `ваш код подключения: "${myBridge.key}", ваш собеседник: ${actualPartnerName}`,
          keyboard
        );
      } else {
        await sendMessage(
          env,
          platform,
          chatId,
          `ваш код подключения: "${myBridge.key}", у вас нет собеседника`,
          keyboard
        );
      }
    }
    return;
  }

  // ---- перевыпустить мост ----
  if (normalized === "перевыпустить мост") {
    if (!myBridge) {
      const key = await generateUniqueKey(env);
      myBridge = {
        key,
        myName: username,
        partnerPlatform: null,
        partnerId: null,
        partnerName: null,
      };
      await saveBridge(env, platform, userId, myBridge);
      await saveOwnerByKey(env, key, { platform, userId });
      await sendMessage(
        env,
        platform,
        chatId,
        `ваш код подключения: "${key}", передайте его собеседнику`,
        keyboard
      );
      return;
    }

    myBridge.myName = username;
    myBridge.pendingAction = "reissue";
    myBridge.pendingExpiresAt = Date.now() + CONFIRM_TTL_MS;
    await saveBridge(env, platform, userId, myBridge);
    await sendMessage(env, platform, chatId, CONFIRM_PROMPT, confirmKeyboard);
    return;
  }

  // ---- просмотреть мост ----
  if (normalized === "просмотреть мост") {
    if (!myBridge) {
      await sendMessage(env, platform, chatId, "у вас пока нет моста, нажмите /start", keyboard);
      return;
    }
    myBridge.myName = username;

    let actualPartnerName = null;
    if (myBridge.partnerPlatform && myBridge.partnerId !== null) {
      const partnerBridge = await getBridge(env, myBridge.partnerPlatform, myBridge.partnerId);
      if (
        partnerBridge &&
        partnerBridge.partnerPlatform === platform &&
        String(partnerBridge.partnerId) === String(userId)
      ) {
        actualPartnerName = partnerBridge.myName || myBridge.partnerName || "собеседник";
        myBridge.partnerName = actualPartnerName;
      } else {
        myBridge.partnerPlatform = null;
        myBridge.partnerId = null;
        myBridge.partnerName = null;
      }
    }

    await saveBridge(env, platform, userId, myBridge);

    if (actualPartnerName) {
      await sendMessage(
        env,
        platform,
        chatId,
        `ваш код подключения: "${myBridge.key}", ваш собеседник: ${actualPartnerName}`,
        keyboard
      );
    } else {
      await sendMessage(
        env,
        platform,
        chatId,
        `ваш код подключения: "${myBridge.key}", у вас нет собеседника`,
        keyboard
      );
    }
    return;
  }

  // ---- отвязать мост ----
  if (normalized === "отвязать мост") {
    if (!myBridge) {
      await sendMessage(env, platform, chatId, "у вас пока нет моста", keyboard);
      return;
    }
    myBridge.myName = username;

    if (myBridge.partnerId === null || !myBridge.partnerPlatform) {
      await saveBridge(env, platform, userId, myBridge);
      await sendMessage(env, platform, chatId, "у вас нет собеседника", keyboard);
      return;
    }

    myBridge.pendingAction = "unlink";
    myBridge.pendingExpiresAt = Date.now() + CONFIRM_TTL_MS;
    await saveBridge(env, platform, userId, myBridge);
    await sendMessage(env, platform, chatId, CONFIRM_PROMPT, confirmKeyboard);
    return;
  }

  // ---- ввод кода подключения ----
  if (isCodeEntry) {
    const extractedKey = keyMatch[0].toLowerCase();
    const owner = await getOwnerByKey(env, extractedKey);

    if (!myBridge) {
      const key = await generateUniqueKey(env);
      myBridge = {
        key,
        myName: username,
        partnerPlatform: null,
        partnerId: null,
        partnerName: null,
      };
      await saveBridge(env, platform, userId, myBridge);
      await saveOwnerByKey(env, key, { platform, userId });
    } else {
      myBridge.myName = username;
    }

    if (!owner) {
      await saveBridge(env, platform, userId, myBridge);
      await sendMessage(env, platform, chatId, "код не найден", keyboard);
      return;
    }

    if (owner.platform === platform && String(owner.userId) === String(userId)) {
      await saveBridge(env, platform, userId, myBridge);
      await sendMessage(env, platform, chatId, "это ваш собственный код", keyboard);
      return;
    }

    if (
      myBridge.partnerPlatform === owner.platform &&
      String(myBridge.partnerId) === String(owner.userId)
    ) {
      await saveBridge(env, platform, userId, myBridge);
      await sendMessage(env, platform, chatId, "вы уже связаны с этим собеседником", keyboard);
      return;
    }

    const ownerBridge = await getBridge(env, owner.platform, owner.userId);
    if (!ownerBridge) {
      await saveBridge(env, platform, userId, myBridge);
      await sendMessage(env, platform, chatId, "собеседник недоступен", keyboard);
      return;
    }

    const ownerName = ownerBridge.myName || "собеседник";

    if (myBridge.partnerPlatform && myBridge.partnerId !== null) {
      const op = myBridge.partnerPlatform;
      const oid = myBridge.partnerId;
      const ob = await getBridge(env, op, oid);
      if (ob && ob.partnerPlatform === platform && String(ob.partnerId) === String(userId)) {
        ob.partnerPlatform = null;
        ob.partnerId = null;
        ob.partnerName = null;
        await saveBridge(env, op, oid, ob);
        await sendMessage(
          env,
          op,
          oid,
          "собеседник нашел другого собеседника",
          op === "tg" ? TG_KEYBOARD : VK_KEYBOARD
        );
      }
    }

    if (ownerBridge.partnerPlatform && ownerBridge.partnerId !== null) {
      const op2 = ownerBridge.partnerPlatform;
      const oid2 = ownerBridge.partnerId;
      const ob2 = await getBridge(env, op2, oid2);
      if (
        ob2 &&
        ob2.partnerPlatform === owner.platform &&
        String(ob2.partnerId) === String(owner.userId)
      ) {
        ob2.partnerPlatform = null;
        ob2.partnerId = null;
        ob2.partnerName = null;
        await saveBridge(env, op2, oid2, ob2);
        await sendMessage(
          env,
          op2,
          oid2,
          "собеседник нашел другого собеседника",
          op2 === "tg" ? TG_KEYBOARD : VK_KEYBOARD
        );
      }
    }

    myBridge.partnerPlatform = owner.platform;
    myBridge.partnerId = owner.userId;
    myBridge.partnerName = ownerName;
    await saveBridge(env, platform, userId, myBridge);

    ownerBridge.partnerPlatform = platform;
    ownerBridge.partnerId = userId;
    ownerBridge.partnerName = username;
    await saveBridge(env, owner.platform, owner.userId, ownerBridge);

    await sendMessage(env, platform, chatId, `вы подключены к ${ownerName}`, keyboard);
    await sendMessage(
      env,
      owner.platform,
      owner.userId,
      `с вами подключился ${username}`,
      owner.platform === "tg" ? TG_KEYBOARD : VK_KEYBOARD
    );
    return;
  }

  // ---- Обычное сообщение — пересылка ----
  if (!myBridge) {
    await sendMessage(env, platform, chatId, ERR_NO_START, keyboard);
    return;
  }

  // Обновляем собственное имя при каждом сообщении
  if (myBridge.myName !== username) {
    myBridge.myName = username;
  }

  if (!myBridge.partnerPlatform || myBridge.partnerId === null) {
    await saveBridge(env, platform, userId, myBridge);
    await sendMessage(env, platform, chatId, ERR_NO_PARTNER, keyboard);
    return;
  }

  const partnerPlatform = myBridge.partnerPlatform;
  const partnerId = myBridge.partnerId;

  const partnerBridge = await getBridge(env, partnerPlatform, partnerId);
  if (
    !partnerBridge ||
    partnerBridge.partnerPlatform !== platform ||
    String(partnerBridge.partnerId) !== String(userId)
  ) {
    myBridge.partnerPlatform = null;
    myBridge.partnerId = null;
    myBridge.partnerName = null;
    await saveBridge(env, platform, userId, myBridge);
    await sendMessage(env, platform, chatId, ERR_PARTNER_LEFT, keyboard);
    return;
  }

  // Синхронизируем актуальное имя собеседника у себя
  const freshPartnerName = partnerBridge.myName || myBridge.partnerName || "собеседник";
  if (myBridge.partnerName !== freshPartnerName) {
    myBridge.partnerName = freshPartnerName;
  }
  await saveBridge(env, platform, userId, myBridge);

  await sendMessage(env, partnerPlatform, partnerId, `сообщение от ${username}: ${text}`);
  await sendMessage(env, platform, chatId, OK_DELIVERED, keyboard);
}

// ============ ОБРАБОТЧИКИ ============

async function handleTelegram(update, env) {
  const message = update && update.message;
  if (!message || typeof message.text !== "string") return;
  const from = message.from;
  if (!from) return;
  const username = from.username ? "@" + from.username : (from.first_name || "пользователь");
  await processMessage(
    {
      platform: "tg",
      userId: from.id,
      chatId: message.chat.id,
      username,
      text: message.text.trim(),
    },
    env
  );
}

async function handleVk(body, env) {
  if (env.VK_SECRET && body.secret !== env.VK_SECRET) return;
  if (body.type === "message_new") {
    const m = body.object && body.object.message;
    if (!m || typeof m.text !== "string" || m.text.length === 0) return;
    const userId = m.from_id;
    const username = await getVkUsername(env, userId);
    await processMessage(
      {
        platform: "vk",
        userId,
        chatId: m.peer_id || userId,
        username,
        text: m.text.trim(),
      },
      env
    );
  }
}

// ============ ГЛАВНЫЙ ЭКСПОРТ ============

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Bot is running", { status: 200 });
    }

    try {
      if (request.method === "POST") {
        const body = await request.json();

        if (body && body.type === "confirmation") {
          return new Response(env.VK_CONFIRMATION_CODE || "", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }

        if (body && body.update_id) {
          const msg = body.message;
          if (!msg) return new Response("OK", { status: 200 });

          const isMedia =
            (msg.photo && msg.photo.length > 0) ||
            msg.document ||
            msg.media_group_id;

          if (isMedia) {
            ctx.waitUntil(handleTgMedia(body, env));
            return new Response("OK", { status: 200 });
          }

          if (typeof msg.text === "string") {
            await handleTelegram(body, env);
          }
          return new Response("OK", { status: 200 });
        }

        if (body && body.type && body.group_id) {
          if (env.VK_SECRET && body.secret !== env.VK_SECRET) {
            return new Response("OK", { status: 200 });
          }

          const msg = body.object && body.object.message;
          if (!msg) return new Response("OK", { status: 200 });

          const hasAttachments = msg.attachments && msg.attachments.length > 0;
          const hasPhoto =
            hasAttachments && msg.attachments.some(a => a.type === "photo");

          if (hasPhoto) {
            ctx.waitUntil(handleVkMedia(body, env));
            return new Response("OK", { status: 200 });
          }

          if (typeof msg.text === "string" && msg.text.length > 0) {
            await handleVk(body, env);
          }
          return new Response("OK", { status: 200 });
        }
      }
    } catch (e) {
      console.error("WORKER ERROR:", e.message, e.stack);
    }

    return new Response("OK", { status: 200 });
  },
};
