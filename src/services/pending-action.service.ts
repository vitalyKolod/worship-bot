import { Types } from "mongoose";
import { PendingAction } from "../models/PendingAction";
import { Rehearsal } from "../models/Rehearsal";
import { WorshipService } from "../models/WorshipService";
import { cancelRehearsal, moveRehearsal } from "./rehearsal.service";
import { replaceLineupAssignments } from "./worship-service.service";
import { moveWorshipService } from "./worship-service.service";

export async function createPendingAction(input: {
  team: Types.ObjectId | string;
  actorTelegramId: number;
  type: "create_rehearsal" | "move_rehearsal" | "cancel_rehearsal" | "move_service" | "set_lineup";
  summary: string;
  payload: Record<string, unknown>;
}) {
  return PendingAction.create({ ...input, expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
}

export async function cancelPendingAction(actionId: string, teamId: Types.ObjectId | string) {
  return PendingAction.findOneAndUpdate(
    { _id: actionId, team: teamId, status: "pending" },
    { $set: { status: "cancelled" } },
    { returnDocument: "after" }
  );
}

export async function applyPendingAction(actionId: string, teamId: Types.ObjectId | string, confirmedBy: number) {
  const action = await PendingAction.findOne({ _id: actionId, team: teamId });
  if (!action || action.expiresAt <= new Date()) return { state: "expired" as const, action: null, result: null };
  if (action.status === "confirmed") return { state: "already_confirmed" as const, action, result: null };
  if (action.status !== "pending") return { state: "cancelled" as const, action, result: null };

  const payload = action.payload as Record<string, any>;
  let result: unknown = null;
  if (action.type === "create_rehearsal") {
    const startsAt = new Date(payload.startsAt);
    if (startsAt <= new Date()) return { state: "invalid" as const, action, result: null };
    result = await Rehearsal.findOneAndUpdate(
      { sourceAction: action._id },
      { $setOnInsert: { team: action.team, startsAt, location: payload.location, comment: payload.comment, createdBy: confirmedBy, sourceAction: action._id } },
      { upsert: true, returnDocument: "after" }
    );
  } else if (action.type === "move_rehearsal") {
    result = await moveRehearsal(action.team, payload.rehearsalId, new Date(payload.startsAt), confirmedBy, payload.location);
  } else if (action.type === "cancel_rehearsal") {
    result = await cancelRehearsal(action.team, payload.rehearsalId, confirmedBy);
  } else if (action.type === "move_service") {
    result = await moveWorshipService(action.team, payload.serviceId, new Date(payload.startsAt), confirmedBy, payload.location);
  } else if (action.type === "set_lineup") {
    const serviceExists = await WorshipService.exists({ _id: payload.serviceId, team: action.team, status: "scheduled" });
    result = serviceExists ? await replaceLineupAssignments(action.team, payload.serviceId, payload.assignments) : null;
  }
  if (!result) return { state: "invalid" as const, action, result: null };
  action.status = "confirmed";
  action.confirmedBy = confirmedBy;
  action.confirmedAt = new Date();
  await action.save();
  console.log(`[PENDING_ACTION] confirmed type=${action.type} team=${action.team}`);
  return { state: "confirmed" as const, action, result };
}
