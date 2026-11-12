// AWS Lambda entry point. A direct invoke carries one event; an SQS trigger
// carries Records[].body. Mirrors the Rust bootstrap.
import { intake, type IntakeEvent } from "./sift.js";

interface SqsBatch {
  Records: { body: string }[];
}

export const handler = async (
  event: IntakeEvent | SqsBatch,
): Promise<unknown> => {
  if ("Records" in event)
    return event.Records.map((r) =>
      intake(JSON.parse(r.body) as IntakeEvent),
    );
  return intake(event);
};
