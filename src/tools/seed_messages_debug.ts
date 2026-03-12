import { openDb } from "../db.js";
import { listUsers } from "../repos/users_repo.js";
import { createGroupRoom, ensureDirectRoom, sendMessageToRoom } from "../services/messages_service.js";

type CliOptions = {
  directPerPair: number;
  groupMessages: number;
  groups: number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function parseArgs(argv: string[]): CliOptions {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 2) {
      map.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(key, next);
      i += 1;
    } else {
      map.set(key, "1");
    }
  }
  return {
    directPerPair: parsePositiveInt(map.get("direct"), 30),
    groupMessages: parsePositiveInt(map.get("group"), 80),
    groups: parsePositiveInt(map.get("groups"), 2)
  };
}

function pickBody(index: number): string {
  const pool = [
    "Проверка статуса и блокеров по задаче.",
    "Взял в работу, обновлюсь после тестов.",
    "Сделал правку, посмотрите пожалуйста.",
    "Добавил логи, нужно перепроверить на стенде.",
    "Есть идея упростить поток, обсудим?",
    "Синхронизировал с последними изменениями.",
    "Нужно подтверждение перед релизом.",
    "Планирую закончить сегодня к вечеру.",
    "Отправил обновление в ветку.",
    "Можно объединять после ревью."
  ];
  return pool[index % pool.length];
}

function pickSubject(index: number): string {
  const pool = [
    "Status update",
    "Quick sync",
    "Draft ready",
    "Need review",
    "Follow-up",
    "Check this",
    "Next step",
    "Question",
    "Ready for merge",
    "Update"
  ];
  return pool[index % pool.length];
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = openDb();
  try {
    const activeUsers = listUsers(db)
      .filter((user) => String(user.status || "").toUpperCase() === "ACTIVE")
      .sort((a, b) => Number(a.id) - Number(b.id));

    if (activeUsers.length < 2) {
      console.log("Need at least 2 active users for direct messages.");
      return;
    }

    const directActors = activeUsers.slice(0, Math.min(activeUsers.length, 6));
    const directPairs: Array<[number, number]> = [];
    for (let i = 0; i < directActors.length; i += 1) {
      for (let j = i + 1; j < directActors.length; j += 1) {
        directPairs.push([directActors[i].id, directActors[j].id]);
      }
    }
    const limitedPairs = directPairs.slice(0, Math.min(directPairs.length, 6));

    let directCreated = 0;
    for (const [userA, userB] of limitedPairs) {
      const roomId = ensureDirectRoom(db, userA, userB);
      for (let i = 0; i < options.directPerPair; i += 1) {
        const sender = i % 2 === 0 ? userA : userB;
        sendMessageToRoom(db, {
          roomId,
          senderUserId: sender,
          subject: pickSubject(i),
          body: `${pickBody(i)} [DM ${i + 1}]`,
          kind: "manual"
        });
        directCreated += 1;
      }
    }

    let groupCreated = 0;
    const groupActors = activeUsers.slice(0, Math.min(activeUsers.length, 8));
    if (groupActors.length >= 3 && options.groups > 0 && options.groupMessages > 0) {
      const owner = groupActors[0];
      const maxGroups = Math.min(options.groups, 4);
      for (let g = 0; g < maxGroups; g += 1) {
        const start = 1 + g;
        const participantSlice = groupActors.slice(start, Math.min(start + 4, groupActors.length));
        const participantIds = participantSlice.map((user) => user.id);
        const participants = [owner, ...participantSlice];
        const roomId = createGroupRoom(
          db,
          owner.id,
          participantIds,
          `Debug Group ${g + 1} ${new Date().toLocaleDateString("en-CA")}`
        );
        for (let i = 0; i < options.groupMessages; i += 1) {
          const sender = participants[i % participants.length];
          const mentionTarget = participants[(i + 1) % participants.length];
          const mentionSuffix = i % 5 === 0 ? ` @${mentionTarget.name || mentionTarget.email}` : "";
          sendMessageToRoom(db, {
            roomId,
            senderUserId: sender.id,
            subject: i % 3 === 0 ? "" : pickSubject(i),
            body: `${pickBody(i)}${mentionSuffix} [GR ${g + 1}.${i + 1}]`,
            kind: "manual"
          });
          groupCreated += 1;
        }
      }
    }

    console.log(
      `Seed complete. Direct messages: ${directCreated}. Group messages: ${groupCreated}.`
    );
    console.log(
      `Options used -> --direct=${options.directPerPair} --group=${options.groupMessages} --groups=${options.groups}`
    );
  } finally {
    db.close();
  }
}

main();
