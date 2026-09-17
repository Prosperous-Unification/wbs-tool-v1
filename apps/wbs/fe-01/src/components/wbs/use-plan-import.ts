import { type ChangeEventHandler, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  planDocumentRequestFromJson,
  PlanDocumentSchemaError,
  PlanImportRefusalError,
  type PlanImportSummary,
  type ProjectApi,
  type ProjectListEntry,
} from '@/lib/wbs-api';

import { failureText } from './plan-refusal';
import type { ToastStackApi } from './toasts';

const readPlanJson = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('file_read_failed'));
    };
    // Proof: removing this rejection made `reports an asynchronous file read
    // failure without submitting` time out with no toast. Observed 2026-09-14.
    reader.onerror = () => {
      reject(new Error('file_read_failed'));
    };
    reader.onabort = () => {
      reject(new Error('file_read_failed'));
    };
    reader.readAsText(file);
  });

const importedNames = (summary: PlanImportSummary): string => {
  const kinds: readonly [string, readonly string[]][] = [
    ['team', summary.created.teams],
    ['person', summary.created.people],
    ['tag', summary.created.tags],
    ['service', summary.created.services],
    ['type', summary.created.types],
    ['external system', summary.created.externalSystems],
  ];
  const created = kinds.flatMap(([kind, names]) =>
    names.length === 0
      ? []
      : [`${String(names.length)} ${kind}${names.length === 1 ? '' : 's'} (${names.join(', ')})`],
  );
  return created.length === 0 ? 'no directory names' : created.join(', ');
};

const importSummarySentence = (summary: PlanImportSummary): string =>
  `Imported ${String(summary.rows)} work item${summary.rows === 1 ? '' : 's'}. Created ${importedNames(summary)}. Solution reference: ${summary.solutionRef}.`;

const importRefusalSentence = (thrown: unknown): string => {
  if (thrown instanceof PlanImportRefusalError) {
    const refusal = thrown.refusal;
    if ('path' in refusal) {
      const detail = refusal.detail === null ? '' : ` (${refusal.detail})`;
      return `Plan JSON import refused: ${refusal.error} at ${refusal.path}${detail}.`;
    }
    return `Plan JSON import refused: ${refusal.error}.`;
  }
  if (thrown instanceof PlanDocumentSchemaError) {
    return `Plan JSON import refused: invalid_body at ${thrown.path} (${thrown.detail}).`;
  }
  return `Plan JSON import failed (${failureText(thrown, 'unknown')}).`;
};

export interface PlanImportControl {
  busy: boolean;
  chooseFile: ChangeEventHandler<HTMLInputElement>;
}

/** Owns one archival import attempt across the keyed plan table's lifetime. */
export function usePlanImport({
  api,
  selectedProjectId,
  fetchProjects,
  installProjects,
  openProject,
  pushToast,
}: {
  api: ProjectApi;
  selectedProjectId: string | null;
  fetchProjects: () => Promise<ProjectListEntry[]>;
  installProjects: (projects: ProjectListEntry[]) => void;
  openProject: (projectId: string) => void;
  pushToast: ToastStackApi['pushToast'];
}): PlanImportControl {
  const lifetime = useMemo(() => ({ api }), [api]);
  const [busyLifetime, setBusyLifetime] = useState<object | null>(null);
  const admittedLifetime = useRef<object | null>(null);
  const currentLifetime = useRef<object | null>(lifetime);
  const currentProject = useRef(selectedProjectId);

  useEffect(() => {
    currentProject.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    currentLifetime.current = lifetime;
    return () => {
      if (currentLifetime.current === lifetime) currentLifetime.current = null;
    };
  }, [lifetime]);

  const chooseFile = useCallback<ChangeEventHandler<HTMLInputElement>>(
    (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (file === undefined) return;
      // Proof: removing this synchronous admission made two rapid changes call
      // `readAsText` twice; the page expected one read. Observed 2026-09-14.
      if (admittedLifetime.current === lifetime) {
        input.value = '';
        return;
      }
      admittedLifetime.current = lifetime;
      setBusyLifetime(lifetime);
      const sourceProjectId = selectedProjectId;
      void (async () => {
        try {
          const source = await readPlanJson(file);
          // Proof: removing this post-read boundary and the pre-write boundary
          // below submitted one write through the replaced API. Observed
          // 2026-09-14.
          if (currentLifetime.current !== lifetime) return;
          const document = await planDocumentRequestFromJson(source);
          if (currentLifetime.current !== lifetime) return;
          const summary = await api.importPlan(document);
          if (currentLifetime.current !== lifetime) return;
          const catalogue = await fetchProjects();
          // Proof: installing before this post-fetch boundary let exact stale
          // project `p3` replace the new lifetime's picker. Observed 2026-09-14.
          if (currentLifetime.current !== lifetime) return;
          installProjects(catalogue);
          if (currentLifetime.current !== lifetime) return;
          if (!catalogue.some((project) => project.id === summary.projectId)) {
            throw new Error('imported_project_missing');
          }
          // Proof: removing this ownership comparison navigated from exact p2
          // back to the completed import p3. Observed 2026-09-14.
          if (currentLifetime.current !== lifetime) return;
          if (currentProject.current === sourceProjectId) openProject(summary.projectId);
          if (currentLifetime.current !== lifetime) return;
          pushToast({ kind: 'info', text: importSummarySentence(summary) });
        } catch (thrown: unknown) {
          if (currentLifetime.current !== lifetime) return;
          pushToast({ kind: 'error', text: importRefusalSentence(thrown) });
        } finally {
          // Proof: removing this reset left the browser-model file path set and
          // the same-file case completed one attempt, not two. Observed 2026-09-14.
          input.value = '';
          if (currentLifetime.current === lifetime) {
            admittedLifetime.current = null;
            setBusyLifetime(null);
          }
        }
      })();
    },
    [api, fetchProjects, installProjects, lifetime, openProject, pushToast, selectedProjectId],
  );

  return { busy: busyLifetime === lifetime, chooseFile };
}
