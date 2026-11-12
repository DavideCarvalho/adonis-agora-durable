import type { AgoraDoctorCheck } from './agora_doctor.js';
import { checkConsoleGate, durableDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorRegistry,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { AGORA_DOCTOR_BINDING, registerDoctorChecks } from './agora_doctor.js';

/**
 * Every durable check, for `node ace agora:doctor --no-boot` (which imports this entry instead of
 * booting the providers). The console check only runs when config/durable_dashboard.ts exists.
 */
export const agoraDoctorChecks: AgoraDoctorCheck[] = [
  ...durableDoctorChecks,
  {
    id: 'durable.console-gate',
    lib: 'durable',
    title: 'Console access in production',
    run: (app) =>
      checkConsoleGate(
        app.config.get<Record<string, unknown> | undefined>('durable_dashboard', undefined),
        app.inProduction,
      ),
  },
];
