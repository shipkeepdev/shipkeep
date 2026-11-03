import { ActionRequestSchema, type ActionRequest } from '../gen/shipkeep/agent/v1/gateway_pb.js';

/**
 * Name of one action in the closed catalogue, as the `action` oneof field name
 * (for example `"createContainer"`).
 */
export type ActionKind = Exclude<ActionRequest['action']['case'], undefined>;

/**
 * Every action kind of the closed catalogue (SPEC section 3.3), in declaration order.
 * Derived from the proto descriptor so it can never drift from the contract.
 */
export const ACTION_KINDS: readonly ActionKind[] = ActionRequestSchema.oneofs
  .filter((oneof) => oneof.name === 'action')
  .flatMap((oneof) => oneof.fields.map((field) => field.localName as ActionKind));

/**
 * Returns the kind of the action carried by a request, or `undefined` when the oneof is empty.
 */
export function actionKind(request: ActionRequest): ActionKind | undefined {
  return request.action.case;
}
