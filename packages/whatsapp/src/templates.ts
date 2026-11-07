/**
 * The three message templates. Business-initiated WhatsApp messages MUST use a
 * template that Meta has approved, so create these (same name, same language,
 * same number of {{n}} variables) in WhatsApp Manager before sending.
 */
export interface TemplateDefinition {
  /** Variable names, in {{1}}, {{2}}, ... order. */
  params: readonly string[];
  language: string;
  category: "UTILITY";
  /** Text to paste into Meta's template editor. */
  text: Readonly<Record<string, string>>;
}

export const TEMPLATES = {
  payment_received: {
    params: ["memberName", "gymName", "expiryDate"],
    language: "ar",
    category: "UTILITY",
    text: {
      ar: "مرحباً {{1}}، تم استلام دفعتك في {{2}}. اشتراكك ساري حتى {{3}}. شكراً لك!",
      en: "Hi {{1}}, we received your payment at {{2}}. Your membership is valid until {{3}}. Thank you!",
    },
  },
  subscription_expiring: {
    params: ["memberName", "gymName", "expiryDate"],
    language: "ar",
    category: "UTILITY",
    text: {
      ar: "مرحباً {{1}}، اشتراكك في {{2}} ينتهي بتاريخ {{3}}. يرجى التجديد لتجنب توقف الدخول.",
      en: "Hi {{1}}, your membership at {{2}} ends on {{3}}. Please renew to keep your access.",
    },
  },
  gym_closed: {
    params: ["memberName", "gymName", "closedDate"],
    language: "ar",
    category: "UTILITY",
    text: {
      ar: "مرحباً {{1}}، نعلمكم أن {{2}} سيكون مغلقاً بتاريخ {{3}}. نعتذر عن الإزعاج.",
      en: "Hi {{1}}, {{2}} will be closed on {{3}}. Sorry for the inconvenience.",
    },
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateName = keyof typeof TEMPLATES;
