import type { Db } from "../db.js";
import { getDoeStudy } from "../repos/doe_repo.js";
import { getQualStepById } from "../repos/qual_repo.js";
import { getReportConfig } from "../repos/reports_repo.js";
import {
  getEntityAssignment,
  type EntityAssignmentType,
  upsertEntityAssignment
} from "../repos/entity_assignments_repo.js";
import {
  createTask,
  createTaskEntity,
  getTask,
  listTaskEntities,
  updateTask,
  updateTaskEntity
} from "../repos/tasks_repo.js";
import { getAssignmentTaskByAssignmentId, upsertAssignmentTask } from "../repos/assignment_tasks_repo.js";
import { sendSystemMessageFromActor } from "./messages_service.js";
import { getQualificationStepName } from "./qualification_service.js";
import { computeTaskProgress, getDefaultEntityWeight, suggestTaskStatusWithRules } from "./tasks_service.js";

function getEntityLabel(db: Db, experimentId: number, entityType: EntityAssignmentType, entityId: number) {
  if (entityType === "qualification_step") {
    const step = getQualStepById(db, entityId);
    const stepNumber = step?.step_number ?? entityId;
    const stepLabel = getQualificationStepName(db, experimentId, stepNumber);
    return `Qualification Step ${stepNumber}: ${stepLabel}`;
  }
  if (entityType === "report") {
    const report = getReportConfig(db, entityId);
    return `Report: ${report?.name ?? `#${entityId}`}`;
  }
  const doe = getDoeStudy(db, entityId);
  return doe?.name ? `DOE: ${doe.name}` : `DOE #${entityId}`;
}

function getEntityPath(db: Db, experimentId: number, entityType: EntityAssignmentType, entityId: number) {
  if (entityType === "qualification_step") {
    const step = getQualStepById(db, entityId);
    return `/experiments/${experimentId}/qualification/${step?.step_number ?? entityId}`;
  }
  if (entityType === "report") return `/reports/${entityId}`;
  return `/experiments/${experimentId}/doe/${entityId}?tab=design`;
}

export function canAssignEntityResponsibility(
  actor: { id?: number; role?: string | null } | undefined,
  experiment: { owner_user_id: number | null }
) {
  const role = actor?.role ?? "";
  if (role === "admin" || role === "manager") return true;
  if (!actor?.id) return false;
  return experiment.owner_user_id != null && experiment.owner_user_id === actor.id;
}

export function assignEntityResponsibility(
  db: Db,
  data: {
    experimentId: number;
    entityType: EntityAssignmentType;
    entityId: number;
    assigneeUserId: number | null;
    assignedByUserId: number | null;
    experimentName: string;
    dueAt?: string | null;
    taskDescription?: string | null;
    taskTitle?: string;
  }
) {
  const previous = getEntityAssignment(db, data.entityType, data.entityId);
  const previousAssigneeId = previous?.assignee_user_id ?? null;

  const assignmentId = upsertEntityAssignment(db, {
    experiment_id: data.experimentId,
    entity_type: data.entityType,
    entity_id: data.entityId,
    assignee_user_id: data.assigneeUserId,
    assigned_by_user_id: data.assignedByUserId
  });

  const entityLabel = getEntityLabel(db, data.experimentId, data.entityType, data.entityId);
  const entityPath = getEntityPath(db, data.experimentId, data.entityType, data.entityId);
  const taskTitle = data.taskTitle?.trim() || `Assigned: ${entityLabel}`;
  const stepNumberForTask =
    data.entityType === "qualification_step" ? getQualStepById(db, data.entityId)?.step_number : null;
  const taskEntityId = data.entityType === "qualification_step" ? (stepNumberForTask ?? data.entityId) : data.entityId;
  const existingLink = getAssignmentTaskByAssignmentId(db, assignmentId);

  if (data.assigneeUserId) {
    if (!existingLink) {
      const taskId = createTask(db, {
        experiment_id: data.experimentId,
        title: taskTitle,
        description: data.taskDescription ?? "Auto-created from entity assignment.",
        owner_user_id: data.assigneeUserId,
        due_at: data.dueAt ?? null
      });
      createTaskEntity(db, {
        task_id: taskId,
        entity_type: data.entityType,
        entity_id: taskEntityId,
        label: entityLabel,
        progress_mode: "milestone",
        weight: getDefaultEntityWeight(data.entityType, taskEntityId),
        signature_required: data.entityType === "report" ? 1 : 0
      });
      upsertAssignmentTask(db, assignmentId, taskId);
    } else {
      const task = getTask(db, existingLink.task_id);
      if (task) {
        updateTask(db, task.id, {
          owner_user_id: data.assigneeUserId,
          title: taskTitle,
          due_at: data.dueAt ?? null,
          description: data.taskDescription ?? task.description,
          ...(previousAssigneeId !== data.assigneeUserId ? { status: "init" as const } : {})
        });
      }
    }

    if (previousAssigneeId !== data.assigneeUserId) {
      sendSystemMessageFromActor(db, {
        actor_user_id: data.assignedByUserId ?? null,
        recipient_user_ids: [data.assigneeUserId],
        kind: "assignment",
        subject: `You were assigned to ${entityLabel}`,
        body: `${data.experimentName}`,
        payload: {
          experiment_id: data.experimentId,
          entity_type: data.entityType,
          entity_id: data.entityId,
          path: entityPath
        }
      });
    }
  } else if (existingLink) {
    // Keep the project task visible on the experiment board, but remove it
    // from the former responsible person's personal list.
    const task = getTask(db, existingLink.task_id);
    if (task) updateTask(db, task.id, { owner_user_id: null, due_at: data.dueAt ?? null });
  }

  if (previousAssigneeId && previousAssigneeId !== data.assigneeUserId) {
    sendSystemMessageFromActor(db, {
      actor_user_id: data.assignedByUserId ?? null,
      recipient_user_ids: [previousAssigneeId],
      kind: "assignment",
      subject: `Assignment updated: ${entityLabel}`,
      body: data.assigneeUserId
        ? `You are no longer responsible for this entity.`
        : `Responsibility was cleared.`,
      payload: {
        experiment_id: data.experimentId,
        entity_type: data.entityType,
        entity_id: data.entityId,
        path: entityPath
      }
    });
  }

  return { assignmentId, previousAssigneeId };
}

// A report task is a milestone: signing the report completes its linked task
// entity, while withdrawing a signature reopens it. Manual task metadata and
// any additional linked entities remain untouched.
export function syncReportTaskSignature(
  db: Db,
  data: { reportId: number; signerUserId: number | null; signedAt: string | null }
) {
  const assignment = getEntityAssignment(db, "report", data.reportId);
  if (!assignment) return;
  const link = getAssignmentTaskByAssignmentId(db, assignment.id);
  if (!link) return;
  const task = getTask(db, link.task_id);
  if (!task) return;
  const entities = listTaskEntities(db, task.id);
  const reportEntity = entities.find(
    (entity) => entity.entity_type === "report" && entity.entity_id === data.reportId
  );
  if (!reportEntity) return;
  updateTaskEntity(db, reportEntity.id, {
    status: data.signedAt ? "done" : "init",
    signature_required: 1,
    signature_user_id: data.signedAt ? data.signerUserId : null,
    signature_at: data.signedAt
  });
  const nextEntities = listTaskEntities(db, task.id);
  const progress = computeTaskProgress(nextEntities);
  updateTask(db, task.id, { status: suggestTaskStatusWithRules(nextEntities, progress) });
}
