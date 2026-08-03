import { z } from 'zod';

export const ReportErrorCode = z.never();
export type ReportErrorCode = z.infer<typeof ReportErrorCode>;

export const ReportError = z.never();
export type ReportError = z.infer<typeof ReportError>;

export const Summary = z.never();
export type Summary = z.infer<typeof Summary>;

export const StepResult = z.never();
export type StepResult = z.infer<typeof StepResult>;

export const Observed = z.never();
export type Observed = z.infer<typeof Observed>;

export const RunResult = z.never();
export type RunResult = z.infer<typeof RunResult>;

export const HealResult = z.never();
export type HealResult = z.infer<typeof HealResult>;

export const GenerateResult = z.never();
export type GenerateResult = z.infer<typeof GenerateResult>;

export const CheckResult = z.never();
export type CheckResult = z.infer<typeof CheckResult>;

export const ReviewResult = z.never();
export type ReviewResult = z.infer<typeof ReviewResult>;

export const ReportEnvelope = z.never();
export type ReportEnvelope = z.infer<typeof ReportEnvelope>;
