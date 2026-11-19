// ============ КЛАВИАТУРЫ ============

const TG_KEYBOARD = {
  keyboard: [
    [{ text: "создать мост" }],
    [{ text: "просмотреть мост" }],
    [{ text: "отвязать мост" }],
  ],
  resize_keyboard: true,
};

const VK_KEYBOARD = {
  one_time: false,
  buttons: [
    [{ action: { type: "text", label: "создать мост" }, color: "primary" }],
    [{ action: { type: "text", label: "просмотреть мост" }, color: "primary" }],
    [{ action: { type: "text", label: "отвязать мост" }, color: "negative" }],
  ],
};

// ============ ГЕНЕРАЦИЯ КЛЮЧА ============

function randomLetter() { return String.fromCharCode(97 + Math.floor(Math.random() * 26)); }
function randomDigit() { return String(Math.floor(Math.random() * 10)); }

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

// ============ ОТПРАВКА СООБЩЕНИЙ ============

async function sendTg(env, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendVk(env, userId, text, keyboard) {
  const params = new URLSearchParams({
    access_token: env.VK_TOKEN, v: "5.131",
    user_id: String(userId), message: text,
    random_id: String(Math.floor(Math.random() * 2147483647)),
  });
  if (keyboard) params.set("keyboard", JSON.stringify(keyboard));
  await fetch("https://api.vk.com/method/messages.send", {
    method: "POST", body: params,
  });
}

async function sendMessage(env, platform, chatId, text, replyMarkup) {
  if (platform === "tg") await sendTg(env, chatId, text, replyMarkup);
  else if (platform === "vk") await sendVk(env, chatId, text, replyMarkup);
}

// ============ ИМЯ VK ============

async function getVkUsername(env, userId) {
  try {
    const params = new URLSearchParams({
      access_token: env.VK_TOKEN, v: "5.131", user_ids: String(userId),
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

// ============ ОСНОВНАЯ ЛОГИКА ============

async function processMessage(msg, env) {
  const { platform, userId, chatId, username, text } = msg;
  const keyboard = platform === "tg" ? TG_KEYBOARD : VK_KEYBOARD;

  let myBridge = await getBridge(env, platform, userId);

  const keyMatch = text.match(/[a-z]{3}-\d{3}-[a-z]{3}/i);
  const isCommand =
    text === "/start" ||
    text === "создать мост" ||
    text === "просмотреть мост" ||
    text === "отвязать мост";
  const isCodeEntry = !isCommand && keyMatch !== null;

  // ---- /start ----
  if (text === "/start") {
    if (!myBridge) {
      const key = await generateUniqueKey(env);
      myBridge = {
        key, myName: username,
        partnerPlatform: null, partnerId: null, partnerName: null,
      };
      await saveBridge(env, platform, userId, myBridge);
      await saveOwnerByKey(env, key, { platform, userId });
      await sendMessage(
        env, platform, chatId,
        `ваш код подключения: "${key}", передайте его собеседнику, или отправьте чужой код для подключения`,
        keyboard
      );
    } else {
      myBridge.myName = username;
      await saveBridge(env, platform, userId, myBridge);
      if (myBridge.partnerId !== null && myBridge.partnerName) {
        await sendMessage(
          env, platform, chatId,
          `ваш код подключения: "${myBridge.key}", ваш собеседник: ${myBridge.partnerName}`,
          keyboard
        );
      } else {
        await sendMessage(
          env, platform, chatId,
          `ваш код подключения: "${myBridge.key}", у вас нет собеседника`,
          keyboard
        );
      }
    }
    return;
  }

  // ---- создать мост ----
  if (text === "создать мост") {
    if (!myBridge) {
      const key = await generateUniqueKey(env);
      myBridge = {
        key, myName: username,
        partnerPlatform: null, partnerId: null, partnerName: null,
      };
      await saveBridge(env, platform, userId, myBridge);
      await saveOwnerByKey(env, key, { platform, userId });
    } else {
      myBridge.myName = username;
      await saveBridge(env, platform, userId, myBridge);
    }
    await sendMessage(
      env, platform, chatId,
      `ваш код подключения: "${myBridge.key}", передайте его собеседнику`,
      keyboard
    );
    return;
  }

  // ---- просмотреть мост ----
  if (text === "просмотреть мост") {
    if (!myBridge) {
      await sendMessage(env, platform, chatId, "у вас пока нет моста, нажмите создать мост", keyboard);
      return;
    }
    myBridge.myName = username;
    await saveBridge(env, platform, userId, myBridge);
    if (myBridge.partnerId !== null && myBridge.partnerName) {
      await sendMessage(
        env, platform, chatId,
        `ваш код подключения: "${myBridge.key}", ваш собеседник: ${myBridge.partnerName}`,
        keyboard
      );
    } else {
      await sendMessage(
        env, platform, chatId,
        `ваш код подключения: "${myBridge.key}", у вас нет собеседника`,
        keyboard
      );
    }
    return;
  }

  // ---- отвязать мост ----
  if (text === "отвязать мост") {
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

    const partnerPlatform = myBridge.partnerPlatform;
    const partnerId = myBridge.partnerId;

    myBridge.partnerPlatform = null;
    myBridge.partnerId = null;
    myBridge.partnerName = null;
    await saveBridge(env, platform, userId, myBridge);

    const partnerBridge = await getBridge(env, partnerPlatform, partnerId);
    if (
      partnerBridge &&
      partnerBridge.partnerPlatform === platform &&
      String(partnerBridge.partnerId) === String(userId)
    ) {
      partnerBridge.partnerPlatform = null;
      partnerBridge.partnerId = null;
      partnerBridge.partnerName = null;
      await saveBridge(env, partnerPlatform, partnerId, partnerBridge);
    }

    await sendMessage(
      env, partnerPlatform, partnerId,
      "собеседник отвязал мост",
      partnerPlatform === "tg" ? TG_KEYBOARD : VK_KEYBOARD
    );
    await sendMessage(env, platform, chatId, "мост отвязан", keyboard);
    return;
  }

  // ---- ввод кода ----
  if (isCodeEntry) {
    const extractedKey = keyMatch[0].toLowerCase();
    const owner = await getOwnerByKey(env, extractedKey);

    if (!myBridge) {
      const key = await generateUniqueKey(env);
      myBridge = {
        key, myName: username,
        partnerPlatform: null, partnerId: null, partnerName: null,
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

    // отключаем моего старого партнёра
    if (myBridge.partnerPlatform && myBridge.partnerId !== null) {
      const op = myBridge.partnerPlatform;
      const oid = myBridge.partnerId;
      const ob = await getBridge(env, op, oid);
      if (ob && ob.partnerPlatform === platform && String(ob.partnerId) === String(userId)) {
        ob.partnerPlatform = null;
        ob.partnerId = null;
        ob.partnerName = null;
        await saveBridge(env, op, oid, ob);
        await sendMessage(env, op, oid, "собеседник нашел другого собеседника", op === "tg" ? TG_KEYBOARD : VK_KEYBOARD);
      }
    }

    // отключаем старого партнёра владельца кода
    if (ownerBridge.partnerPlatform && ownerBridge.partnerId !== null) {
      const op2 = ownerBridge.partnerPlatform;
      const oid2 = ownerBridge.partnerId;
      const ob2 = await getBridge(env, op2, oid2);
      if (ob2 && ob2.partnerPlatform === owner.platform && String(ob2.partnerId) === String(owner.userId)) {
        ob2.partnerPlatform = null;
        ob2.partnerId = null;
        ob2.partnerName = null;
        await saveBridge(env, op2, oid2, ob2);
        await sendMessage(env, op2, oid2, "собеседник нашел другого собеседника", op2 === "tg" ? TG_KEYBOARD : VK_KEYBOARD);
      }
    }

    // связываем
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
      env, owner.platform, owner.userId,
      `с вами подключился ${username}`,
      owner.platform === "tg" ? TG_KEYBOARD : VK_KEYBOARD
    );
    return;
  }

  // ---- пересылка сообщения ----
  if (!myBridge) {
    await sendMessage(env, platform, chatId, "нажмите /start для регистрации", keyboard);
    return;
  }
  if (!myBridge.partnerPlatform || myBridge.partnerId === null) {
    await sendMessage(env, platform, chatId, "у вас нет собеседника, отправьте код подключения или поделитесь своим", keyboard);
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
    await sendMessage(env, platform, chatId, "собеседник отвязал мост", keyboard);
    return;
  }

  await sendMessage(env, partnerPlatform, partnerId, `сообщение от ${username}: ${text}`);
  await sendMessage(env, platform, chatId, "сообщение доставлено", keyboard);
}

// ============ ОБРАБОТЧИК TG ============

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

// ============ ОБРАБОТЧИК VK ============

async function handleVk(body, env) {
  if (env.VK_SECRET && body.secret !== env.VK_SECRET) return;
  if (body.type === "message_new") {
    const m = body.object && body.object.message;
    if (!m || typeof m.text !== "string") return;
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
          const confirm = env.VK_CONFIRMATION_CODE || "";
          return new Response(confirm, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }

        if (body && body.update_id) {
          await handleTelegram(body, env);
        } else if (body && body.type && body.group_id) {
          await handleVk(body, env);
        }
      }
    } catch (e) {
      console.error("WORKER ERROR:", e.message, e.stack);
    }

    return new Response("OK", { status: 200 });
  },
};
