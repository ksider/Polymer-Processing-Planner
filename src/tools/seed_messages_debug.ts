import { openDb } from "../db.js";
import { listUsers } from "../repos/users_repo.js";
import { listExperimentsWithMeta } from "../repos/experiments_repo.js";
import { listQualSteps } from "../repos/qual_repo.js";
import { listDoeStudies } from "../repos/doe_repo.js";
import { listReportConfigs } from "../repos/reports_repo.js";
import {
  buildEntityAttachment,
  createGroupRoom,
  ensureDirectRoom,
  sendMessageToRoom,
  sendSystemMessageFromActor,
  togglePinMessage
} from "../services/messages_service.js";

type CliOptions = {
  reset: boolean;
};

type ActiveUser = {
  id: number;
  name: string | null;
  email: string;
  role: string | null;
};

type EntityRef = {
  experiment?: ReturnType<typeof listExperimentsWithMeta>[number];
  qualStepId?: number;
  doeId?: number;
  reportId?: number;
};

function parseArgs(argv: string[]): CliOptions {
  return {
    reset: argv.includes("--reset")
  };
}

function label(user: ActiveUser) {
  return user.name || user.email;
}

function resetMessagingData(db: ReturnType<typeof openDb>) {
  const tx = db.transaction(() => {
    db.exec(`
      DELETE FROM chat_room_pins;
      DELETE FROM message_edits;
      DELETE FROM message_drafts;
      DELETE FROM message_boxes;
      DELETE FROM chat_room_members;
      DELETE FROM messages;
      DELETE FROM chat_rooms;
    `);
    try {
      db.exec(`
        DELETE FROM sqlite_sequence
        WHERE name IN (
          'chat_rooms',
          'chat_room_members',
          'messages',
          'message_boxes',
          'message_edits',
          'message_drafts',
          'chat_room_pins'
        );
      `);
    } catch {
      // sqlite_sequence may not exist in every setup
    }
  });
  tx();
}

function getAttachment(
  db: ReturnType<typeof openDb>,
  entityType: "experiment" | "qualification_step" | "doe" | "report",
  entityId: number | undefined
) {
  if (!entityId) return null;
  return buildEntityAttachment(db, entityType, entityId);
}

function sendDomainMessage(
  db: ReturnType<typeof openDb>,
  roomId: number,
  senderUserId: number,
  subject: string,
  body: string,
  options?: {
    replyToMessageId?: number;
    attachment?: ReturnType<typeof buildEntityAttachment> | null;
  }
) {
  return sendMessageToRoom(db, {
    roomId,
    senderUserId,
    subject,
    body,
    replyToMessageId: options?.replyToMessageId ?? null,
    kind: "manual",
    payload: options?.attachment ? { attachment: options.attachment } : null
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = openDb();

  try {
    if (options.reset) {
      resetMessagingData(db);
    }

    const activeUsers = listUsers(db)
      .filter((user) => String(user.status || "").toUpperCase() === "ACTIVE")
      .sort((a, b) => Number(a.id) - Number(b.id)) as ActiveUser[];

    if (activeUsers.length < 3) {
      console.log("Need at least 3 active users for the domain debug seed.");
      return;
    }

    const [admin, operator, engineer] = activeUsers;
    const experiments = listExperimentsWithMeta(db, false).sort((a, b) => Number(b.id) - Number(a.id));
    const coating = experiments.find((item) => item.name === "coating Demo") ?? experiments[0];
    const compounding = experiments.find((item) => item.name === "compounding demo") ?? experiments[1] ?? experiments[0];
    const gs = experiments.find((item) => item.name === "GS_50pw") ?? experiments[2] ?? experiments[0];
    const im = experiments.find((item) => item.name === "IM scale-up") ?? experiments[3] ?? experiments[0];

    const refs = {
      coating: {
        experiment: coating,
        qualStepId: listQualSteps(db, coating.id)[1]?.id,
        doeId: listDoeStudies(db, coating.id)[0]?.id
      },
      compounding: {
        experiment: compounding,
        qualStepId: listQualSteps(db, compounding.id)[2]?.id,
        doeId: listDoeStudies(db, compounding.id)[0]?.id
      },
      gs: {
        experiment: gs,
        qualStepId: listQualSteps(db, gs.id)[1]?.id,
        doeId: listDoeStudies(db, gs.id)[0]?.id
      },
      im: {
        experiment: im,
        qualStepId: listQualSteps(db, im.id)[2]?.id,
        doeId: listDoeStudies(db, im.id)[0]?.id,
        reportId: listReportConfigs(db, im.id)[0]?.id
      }
    };

    let directCount = 0;
    let groupCount = 0;
    let systemCount = 0;

    const adminEngineerRoom = ensureDirectRoom(db, admin.id, engineer.id);
    const adminOperatorRoom = ensureDirectRoom(db, admin.id, operator.id);
    const engineerOperatorRoom = ensureDirectRoom(db, engineer.id, operator.id);

    let replySeed: number | null = null;
    replySeed = sendDomainMessage(
      db,
      adminEngineerRoom,
      admin.id,
      `DOE plan for ${im.name}`,
      `Нужно сегодня закрыть факторы для ${im.name}. Посмотри, можно ли оставить текущий центр-поинт и не добавлять еще один прогон.`,
      { attachment: getAttachment(db, "doe", refs.im.doeId) }
    );
    directCount += 1;
    replySeed = sendDomainMessage(
      db,
      adminEngineerRoom,
      engineer.id,
      "Re: DOE plan",
      `Проверил матрицу. Для ${im.name} я бы не добавлял новый центр-поинт, но предлагаю расширить окно по hold pressure перед запуском DOE.`,
      { replyToMessageId: replySeed ?? undefined, attachment: getAttachment(db, "experiment", refs.im.experiment.id) }
    );
    directCount += 1;
    sendDomainMessage(
      db,
      adminEngineerRoom,
      admin.id,
      "Report sign-off",
      `Тогда доводи DOE и после этого собери черновик отчета. Хочу увидеть блок по pressure drop и рекомендацию по окну процесса.`,
      { attachment: getAttachment(db, "report", refs.im.reportId) }
    );
    directCount += 1;
    sendDomainMessage(
      db,
      adminEngineerRoom,
      engineer.id,
      "Qualification summary",
      `Ок. Еще по ${gs.name}: на втором шаге разбаланс по полостям ушел после коррекции V/P switch, но нужно подтвердить двумя повторными циклами.`,
      { attachment: getAttachment(db, "qualification_step", refs.gs.qualStepId) }
    );
    directCount += 1;

    replySeed = sendDomainMessage(
      db,
      adminOperatorRoom,
      admin.id,
      `Preparation for ${gs.name}`,
      `Перед следующим окном по ${gs.name} проверь сушку материала и запиши фактическое время стабилизации температуры цилиндра.`,
      { attachment: getAttachment(db, "qualification_step", refs.gs.qualStepId) }
    );
    directCount += 1;
    sendDomainMessage(
      db,
      adminOperatorRoom,
      operator.id,
      "Machine ready",
      `Сушка выставлена на 4 часа, температура цилиндра стабилизировалась через 18 минут. Могу начинать серию после замера веса первых 5 деталей.`,
      { replyToMessageId: replySeed ?? undefined }
    );
    directCount += 1;
    sendDomainMessage(
      db,
      adminOperatorRoom,
      admin.id,
      "Sampling",
      `Да, запускай. Для первой серии оставь текущий back pressure и не меняй cushion, пока не снимем вес и визуал по усадке.`,
      { attachment: getAttachment(db, "experiment", refs.gs.experiment.id) }
    );
    directCount += 1;
    sendDomainMessage(
      db,
      adminOperatorRoom,
      operator.id,
      "Observation",
      `На старте есть небольшой flash на одной полости. После прогрева формы и чистки сопла стало лучше, но фото все равно приложу позже в заметки.`,
    );
    directCount += 1;

    replySeed = sendDomainMessage(
      db,
      engineerOperatorRoom,
      engineer.id,
      `${compounding.name} lot check`,
      `Нужно подтвердить, что в ${compounding.name} стоит правильная партия наполнителя и что feeder не уходит в пульсацию на текущем setpoint.`,
      { attachment: getAttachment(db, "experiment", refs.compounding.experiment.id) }
    );
    directCount += 1;
    sendDomainMessage(
      db,
      engineerOperatorRoom,
      operator.id,
      "Feeder status",
      `Партия совпадает, feeder стабилен. На 42 rpm колебание меньше 1%. Могу снять дополнительный чек по torque, если нужно.`,
      { replyToMessageId: replySeed ?? undefined }
    );
    directCount += 1;
    sendDomainMessage(
      db,
      engineerOperatorRoom,
      engineer.id,
      "Torque trend",
      `Сними, пожалуйста. Если torque останется ровным, оставим это окно как базовое для DOE и не будем менять screw speed.`,
      { attachment: getAttachment(db, "doe", refs.compounding.doeId) }
    );
    directCount += 1;
    sendDomainMessage(
      db,
      engineerOperatorRoom,
      operator.id,
      "Run complete",
      `Принято. После текущего окна выгружу значения и отмечу серию как готовую для анализа.`,
    );
    directCount += 1;

    const gsRoom = createGroupRoom(db, admin.id, [operator.id, engineer.id], `${gs.name} qualification`);
    const gsMessages: Array<{ sender: ActiveUser; subject: string; body: string; attachment?: ReturnType<typeof buildEntityAttachment> | null; mention?: string; reply?: number | null }> = [
      {
        sender: admin,
        subject: "Plan for today",
        body: `Коллеги, сегодня по ${gs.name} закрываем cavity balance и подтверждаем окно по transfer position. @${label(engineer)} нужно сразу сказать, достаточно ли данных для summary.`,
        attachment: getAttachment(db, "qualification_step", refs.gs.qualStepId)
      },
      {
        sender: operator,
        subject: "",
        body: `Запустил серию. После прогрева формы разброс по массе снизился, но одна полость все еще тяжелее примерно на 0.12 г. @${label(admin)} если нужно, могу сместить V/P switch на 0.8 мм.`
      },
      {
        sender: engineer,
        subject: "Trend looks usable",
        body: `Для summary данных уже почти достаточно. Давайте еще две серии после смещения switch, чтобы не спорить потом на ревью, почему окно не подтверждено.`,
        attachment: getAttachment(db, "experiment", refs.gs.experiment.id)
      },
      {
        sender: admin,
        subject: "",
        body: `Ок, двигаем switch и оставляем hold pressure без изменений. После этого зафиксируем окно и уйдем на визуальный осмотр деталей.`
      },
      {
        sender: operator,
        subject: "After adjustment",
        body: `После смещения switch разброс ушел, cavity balance стал ровнее. Подтверждаю, что серия выглядит стабильной.`,
        attachment: getAttachment(db, "qualification_step", refs.gs.qualStepId)
      }
    ];
    let lastGroupMessageId: number | null = null;
    gsMessages.forEach((entry, index) => {
      lastGroupMessageId = sendDomainMessage(db, gsRoom, entry.sender.id, entry.subject, entry.body, {
        attachment: entry.attachment ?? null,
        replyToMessageId: index === 3 ? (lastGroupMessageId ?? undefined) : undefined
      });
      groupCount += 1;
    });
    if (lastGroupMessageId) togglePinMessage(db, { userId: admin.id, roomId: gsRoom, messageId: lastGroupMessageId });

    const imRoom = createGroupRoom(db, engineer.id, [admin.id, operator.id], `${im.name} optimisation`);
    const imMessages = [
      {
        sender: engineer,
        subject: "DOE kickoff",
        body: `По ${im.name} предлагаю сегодня закрыть baseline run и проверить, не вылезает ли pressure drop на верхнем уровне melt temp. @${label(operator)} подготовь машину без смены материала.`,
        attachment: getAttachment(db, "doe", refs.im.doeId)
      },
      {
        sender: operator,
        subject: "",
        body: `Машина готова. Текущее окно держится ровно, предупреждений по гидравлике нет. Могу начать baseline после подтверждения shot size.`
      },
      {
        sender: admin,
        subject: "Proceed",
        body: `Идем. Baseline нужен сегодня, иначе отчет сдвинется. Если увидите нестабильность по cushion, сразу фиксируйте и останавливайте серию.`,
        attachment: getAttachment(db, "report", refs.im.reportId)
      },
      {
        sender: engineer,
        subject: "",
        body: `Принял. После baseline соберу промежуточный вывод и обновлю секцию recommendations в отчете.`
      }
    ];
    let imPinId: number | null = null;
    imMessages.forEach((entry, index) => {
      const id = sendDomainMessage(db, imRoom, entry.sender.id, entry.subject, entry.body, {
        attachment: entry.attachment ?? null,
        replyToMessageId: index === 3 ? (imPinId ?? undefined) : undefined
      });
      if (index === 2) imPinId = id;
      groupCount += 1;
    });
    if (imPinId) togglePinMessage(db, { userId: engineer.id, roomId: imRoom, messageId: imPinId });

    const coatingRoom = createGroupRoom(db, admin.id, [engineer.id, operator.id], `${coating.name} transfer`);
    [
      {
        sender: admin,
        subject: "Scale-up readiness",
        body: `По ${coating.name} нужно согласовать, готовы ли мы переносить текущее окно на следующую машину. Хочу отдельный комментарий по uniformity после последней серии.`,
        attachment: getAttachment(db, "experiment", refs.coating.experiment.id)
      },
      {
        sender: engineer,
        subject: "",
        body: `Uniformity стала лучше после коррекции скорости линии. Но без DOE по coating thickness я бы не переносил окно как финальное.`
      },
      {
        sender: operator,
        subject: "",
        body: `С практической стороны линия работает стабильно. Если оставляем еще одну серию, мне нужен новый target по airflow, чтобы не гадать на старте.`,
        attachment: getAttachment(db, "doe", refs.coating.doeId)
      }
    ].forEach((entry) => {
      sendDomainMessage(db, coatingRoom, entry.sender.id, entry.subject, entry.body, {
        attachment: entry.attachment ?? null
      });
      groupCount += 1;
    });

    const systemPayloads = [
      {
        recipient: engineer.id,
        subject: `Review requested for ${im.name} report`,
        body: `Черновик отчета готов к проверке. Посмотри секцию recommendations и подпиши после замечаний.`,
        attachment: getAttachment(db, "report", refs.im.reportId)
      },
      {
        recipient: operator.id,
        subject: `Run scheduled for ${gs.name}`,
        body: `Следующая квалификационная серия запланирована на утро. Подтверди готовность материала и формы до начала смены.`,
        attachment: getAttachment(db, "qualification_step", refs.gs.qualStepId)
      },
      {
        recipient: admin.id,
        subject: `${compounding.name} DOE baseline completed`,
        body: `Базовое окно отработано без отклонений. Можно переходить к следующему фактору после проверки torque trend.`,
        attachment: getAttachment(db, "doe", refs.compounding.doeId)
      }
    ];

    systemPayloads.forEach((entry) => {
      sendSystemMessageFromActor(db, {
        actor_user_id: admin.id,
        recipient_user_ids: [entry.recipient],
        kind: "system",
        subject: entry.subject,
        body: entry.body,
        payload: entry.attachment ? { attachment: entry.attachment } : null
      });
      systemCount += 1;
    });

    console.log(`Messaging debug seed complete.`);
    console.log(`Reset: ${options.reset ? "yes" : "no"}`);
    console.log(`Direct messages: ${directCount}`);
    console.log(`Group messages: ${groupCount}`);
    console.log(`System notifications: ${systemCount}`);
  } finally {
    db.close();
  }
}

main();
