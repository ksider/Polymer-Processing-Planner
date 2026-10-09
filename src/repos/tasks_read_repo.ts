import type { Db } from "../db.js";

export type MyTaskRow = {
  task_id: number;
  title: string;
  status: string;
  due_at: string | null;
  experiment_id: number;
  experiment_name: string;
  process_name: string | null;
  process_route_code: string | null;
  process_type_code: string | null;
};

// List tasks where the user is owner or assigned operator.
export function listTasksForUser(db: Db, userId: number): MyTaskRow[] {
  return db.prepare(
    `SELECT t.id as task_id, t.title, t.status, t.due_at,
            e.id as experiment_id, e.name as experiment_name,
            p.name as process_name, p.route_code as process_route_code,
            pt.code as process_type_code
     FROM tasks t
     JOIN experiments e ON e.id = t.experiment_id
     LEFT JOIN processes p ON p.id = e.process_id
     LEFT JOIN process_types pt ON pt.id = p.process_type_id
     LEFT JOIN task_assignments a ON a.task_id = t.id
     WHERE t.owner_user_id = ? OR a.user_id = ?
     GROUP BY t.id
     ORDER BY t.due_at IS NULL, t.due_at, t.id DESC`
  ).all(userId, userId) as MyTaskRow[];
}
