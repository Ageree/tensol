export const name = 'services/report-builder' as const;

export { handleReportBuild } from './worker.ts';
export type {
  AuditEmitter,
  AuditEmitterArgs,
  ConfirmedFindingsLoader,
  FindingEvidenceRow,
  FindingRow,
  ReportBuilderDeps,
  ReportMarkBuilding,
  ReportMarkFailed,
  ReportMarkReady,
  ReportReadyInput,
  ReportStatusLoader,
  ReportStatusRow,
} from './worker.ts';
export { reportBuildPayloadSchema, type ReportBuildPayload } from './payload-schema.ts';
