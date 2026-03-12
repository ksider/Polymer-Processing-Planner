import type { Db } from "../db.js";
import { getDoeStudy } from "../repos/doe_repo.js";
import { getQualStepById } from "../repos/qual_repo.js";
import {
  getEntityAssignment,
  type EntityAssignmentType,
  upsertEntityAssignment
} from "../repos/entity_assignments_repo.js";
import { createTask, createTaskEntity, getTask, updateTask } from "../repos/tasks_repo.js";
import { getAssignmentTaskByAssignmentId, upsertAssignmentTask } from "../repos/assignment_tasks_repo.js";
import { sendSystemMessageFromActor } from "./messages_service.js";
import { getQualificationStepName } from "./qualification_service.js";

function getEntityLabel(db: Db, experimentId: number, entityType: EntityAssignmentType, entityId: number) {
  if (entityType === "qualification_step") {
    const step = getQualStepById(db, entityId);
    const stepNumber = step?.step_number ?? entityId;
    const stepLabel = getQualificationStepName(db, experimentId, stepNumber);
    return `Qualification Step ${stepNumber}: ${stepLabel}`;
  }
  const doe = getDoeStudy(db, entityId);
  return doe?.name ? `DOE: ${doe.name}` : `DOE #${entityId}`;
}

function getEntityPath(db: Db, experimentId: number, entityType: EntityAssignmentType, entityId: number) {
  if (entityType === "qualification_step") {
    const step = getQualStepById(db, entityId);
    return `/experiments/${experimentId}/qualification/${step?.step_number ?? entityId}`;
  }
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
  const stepNumberForTask =
    data.entityType === "qualification_step" ? getQualStepById(db, data.entityId)?.step_number : null;
  const taskEntityId = data.entityType === "qualification_step" ? (stepNumberForTask ?? data.entityId) : data.entityId;

  if (data.assigneeUserId) {
    const existingLink = getAssignmentTaskByAssignmentId(db, assignmentId);
    if (!existingLink) {
      const taskId = createTask(db, {
        experiment_id: data.experimentId,
        title: `Assigned: ${entityLabel}`,
        description: `Auto-created from entity assignment.`,
        owner_user_id: data.assigneeUserId
      });
      createTaskEntity(db, {
        task_id: taskId,
        entity_type: data.entityType,
        entity_id: taskEntityId,
        label: entityLabel,
        progress_mode: "milestone",
        weight: 1,
        signature_required: 0
      });
      upsertAssignmentTask(db, assignmentId, taskId);
    } else {
      const task = getTask(db, existingLink.task_id);
      if (task) {
        updateTask(db, task.id, {
          owner_user_id: data.assigneeUserId,
          title: `Assigned: ${entityLabel}`,
          status: "init"
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
