import type { RuleModule } from "@typescript-eslint/utils/ts-eslint";

export interface RuleOptions {
  methods?: string[];
  fragmentMarkers?: string[];
}

type MessageIds = "unsafeInterpolation" | "unsafeConcatenation";

export declare const rule: RuleModule<MessageIds, [RuleOptions]>;
