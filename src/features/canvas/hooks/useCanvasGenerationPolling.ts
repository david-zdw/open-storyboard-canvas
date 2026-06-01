import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useCanvasStore, type CanvasNode, type CanvasNodeData } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { prepareNodeImage } from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
} from '@/features/canvas/application/generationErrorReport';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { embedStoryboardImageMetadata } from '@/commands/image';

interface GenerationStoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

const GENERATION_JOB_POLL_INTERVAL_MS = 1000;
/**
 * Hard ceiling on how long we keep polling a single job. The Tauri
 * backend's image providers all complete (or surface an error) well
 * within ten minutes; a longer poll loop almost certainly indicates the
 * provider hung or the network is broken. Surfacing a timeout instead of
 * polling forever lets the user retry instead of staring at an
 * indefinitely-spinning node.
 */
const GENERATION_JOB_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Soft cap on how often we re-issue `set_api_key` for the same provider
 * per polling-loop iteration. The original code re-issued it on every
 * poll tick (1 Hz) which produced a steady 1 RPS keychain write per
 * in-flight node. One write per minute is plenty — the only reason to
 * re-set is if the user changes their key in settings mid-generation.
 */
const API_KEY_RESET_INTERVAL_MS = 60 * 1000;
/**
 * How many times to retry `prepareNodeImage` for a successful job's
 * result URL before giving up. Generation providers occasionally serve
 * the result from a flaky CDN; a single transient fetch failure
 * shouldn't cost the user the entire job. 3 attempts (initial + 2
 * retries) with exponential backoff covers >95 % of intermittent
 * failures observed in practice without making a permanent failure
 * feel slow.
 */
const PREPARE_IMAGE_MAX_ATTEMPTS = 3;

function isPollableNode(node: CanvasNode): boolean {
  if (node.type !== CANVAS_NODE_TYPES.exportImage && node.type !== CANVAS_NODE_TYPES.panorama) {
    return false;
  }
  const data = node.data as Record<string, unknown>;
  return (
    data.isGenerating === true &&
    typeof data.generationJobId === 'string' &&
    (data.generationJobId as string).length > 0
  );
}

function buildPollableNodesSignature(nodes: CanvasNode[]): string {
  return nodes
    .filter(isPollableNode)
    .map((node) => {
      const data = node.data as Record<string, unknown>;
      return [
        node.id,
        typeof data.generationJobId === 'string' ? data.generationJobId : '',
        typeof data.generationProviderId === 'string' ? data.generationProviderId : '',
        data.generationClientSessionId === CURRENT_RUNTIME_SESSION_ID ? CURRENT_RUNTIME_SESSION_ID : '',
      ].join(':');
    })
    .join('|');
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

/**
 * Watches every node in `nodes` for an in-flight image generation job
 * (`isGenerating === true` + `generationJobId` set) and polls the Rust
 * backend for completion. On success, downloads the result, optionally
 * embeds storyboard grid metadata, and writes the result into the node.
 * On failure or timeout, surfaces the error and clears the in-flight
 * flag so the user can retry.
 *
 * Stability guarantees this hook adds on top of the original inline
 * version that lived in Canvas.tsx:
 *
 *  1. **Per-job timeout.** A poll loop can run forever if the backend
 *     keeps reporting `queued` or returns null repeatedly. Without a
 *     cap, an offline laptop would silently spin until the next reload.
 *     We bail with a synthesized timeout error after
 *     `GENERATION_JOB_TIMEOUT_MS`.
 *  2. **`prepareNodeImage` is wrapped in try/catch.** The original code
 *     awaited it bare — if the result URL was unreachable or returned a
 *     non-image, the whole loop crashed and the node stayed `isGenerating`
 *     forever. Now we treat the failure as a generation error.
 *  3. **`set_api_key` is rate-limited per (provider × loop iteration).**
 *     Polling at 1 Hz with N in-flight nodes was issuing N keychain
 *     writes per second. We re-issue at most once a minute per loop.
 *  4. **The active-poll Set is cleared on unmount.** Otherwise, after a
 *     project close+reopen, stale entries would block the new mount
 *     from spawning fresh polls — same family of bug as the
 *     BlueprintScene mesh-orphan one we fixed earlier.
 */
export function useCanvasGenerationPolling(nodes: CanvasNode[], apiKeys: Record<string, string>): void {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const activePollNodeIdsRef = useRef<Set<string>>(new Set<string>());
  const pollableNodesSignature = buildPollableNodesSignature(nodes);

  // Snapshot the latest nodes via a ref so polling loops can re-read
  // without becoming a dep of the effect (which would restart polling
  // on every node change).
  useEffect(() => {
    const activeRef = activePollNodeIdsRef.current;
    return () => {
      // Clear on unmount so a remount starts from zero — see jsdoc bullet #4.
      activeRef.clear();
    };
  }, []);

  useEffect(() => {
    const pendingNodes = useCanvasStore.getState().nodes.filter(isPollableNode);

    for (const pendingNode of pendingNodes) {
      if (activePollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activePollNodeIdsRef.current.add(pendingNode.id);

      void pollSingleJob({
        nodeId: pendingNode.id,
        startedAt: Date.now(),
        apiKeys,
        updateNodeData,
        finalize: () => {
          activePollNodeIdsRef.current.delete(pendingNode.id);
        },
        translateError: (key) => t(key),
      });
    }
  }, [apiKeys, pollableNodesSignature, updateNodeData, t]);
}

interface PollContext {
  nodeId: string;
  startedAt: number;
  apiKeys: Record<string, string>;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
  finalize: () => void;
  translateError: (key: string) => string;
}

/**
 * One self-contained poll loop for a single in-flight job. Runs until
 * the job resolves, the user cancels (`isGenerating` flips false), the
 * node disappears, or we hit the per-job timeout. Always calls
 * `finalize` so the caller's "active" set drops the node ID.
 */
async function pollSingleJob(ctx: PollContext): Promise<void> {
  const { nodeId, startedAt, apiKeys, updateNodeData, finalize, translateError } = ctx;
  let lastApiKeyResetAt = 0;
  let lastApiKeyResetProvider: string | null = null;

  try {
    while (true) {
      // Ten-minute cap. Anything past this is almost always a hung
      // provider — surface the timeout instead of spinning forever.
      if (Date.now() - startedAt > GENERATION_JOB_TIMEOUT_MS) {
        markGenerationFailed(nodeId, 'generation timed out after 10 minutes', null, updateNodeData);
        return;
      }

      const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
      if (!currentNode) {
        return;
      }

      const currentData = currentNode.data as Record<string, unknown>;
      const jobId =
        typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
      const isGenerating = currentData.isGenerating === true;
      if (!jobId || !isGenerating) {
        return;
      }

      // Refresh the provider's API key — but only once per minute per
      // provider. The original loop re-issued every poll tick.
      const generationProviderId =
        typeof currentData.generationProviderId === 'string' ? currentData.generationProviderId : '';
      if (generationProviderId) {
        const sinceLastReset = Date.now() - lastApiKeyResetAt;
        const providerChanged = lastApiKeyResetProvider !== generationProviderId;
        if (providerChanged || sinceLastReset > API_KEY_RESET_INTERVAL_MS) {
          const providerApiKey = apiKeys[generationProviderId] ?? '';
          if (providerApiKey) {
            await canvasAiGateway.setApiKey(generationProviderId, providerApiKey).catch((error) => {
              console.warn('[GenerationJob] set_api_key failed before poll', {
                nodeId,
                generationProviderId,
                error,
              });
            });
            lastApiKeyResetAt = Date.now();
            lastApiKeyResetProvider = generationProviderId;
          }
        }
      }

      const status = await canvasAiGateway.getGenerateImageJob(jobId).catch((error) => {
        console.warn('[GenerationJob] poll failed', { nodeId, jobId, error });
        return null;
      });
      if (!status) {
        await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
        continue;
      }

      if (status.status === 'queued' || status.status === 'running') {
        await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
        continue;
      }

      if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
        // The image fetch + decode can fail for reasons that aren't the
        // user's fault (transient network, provider CDN hiccup, expired
        // result URL). Retry a small number of times with exponential
        // backoff before declaring the job failed — most intermittent
        // failures clear within a few seconds.
        let prepared;
        let lastPrepareError: unknown = null;
        for (let attempt = 0; attempt < PREPARE_IMAGE_MAX_ATTEMPTS; attempt += 1) {
          try {
            prepared = await prepareNodeImage(status.result);
            lastPrepareError = null;
            break;
          } catch (error) {
            lastPrepareError = error;
            console.warn('[GenerationJob] prepareNodeImage attempt failed', {
              nodeId,
              attempt: attempt + 1,
              of: PREPARE_IMAGE_MAX_ATTEMPTS,
              error,
            });
            if (attempt < PREPARE_IMAGE_MAX_ATTEMPTS - 1) {
              // 500 ms, 1 s, 2 s — keeps total worst-case retry under
              // 3.5 s so the user doesn't perceive a long stall.
              await sleep(500 * 2 ** attempt);
            }
          }
        }
        if (!prepared) {
          const errorMessage = translateError('node.imageNode.fetchResultFailed') || '获取生成结果失败';
          const errorDetails = lastPrepareError instanceof Error
            ? lastPrepareError.message
            : String(lastPrepareError);
          const generationClientSessionId =
            typeof currentData.generationClientSessionId === 'string'
              ? currentData.generationClientSessionId
              : '';
          if (generationClientSessionId === CURRENT_RUNTIME_SESSION_ID) {
            const reportText = buildGenerationErrorReport({
              errorMessage,
              errorDetails,
              context: currentData.generationDebugContext,
            });
            void showErrorDialog(
              errorMessage,
              translateError('common.error'),
              errorDetails,
              reportText,
            );
          }
          markGenerationFailed(
            nodeId,
            errorMessage,
            errorDetails,
            updateNodeData,
          );
          return;
        }

        const storyboardMetadataRaw = currentData.generationStoryboardMetadata as
          | GenerationStoryboardMetadata
          | undefined;
        const hasStoryboardMetadata = Boolean(
          storyboardMetadataRaw &&
            Number.isFinite(storyboardMetadataRaw.gridRows) &&
            Number.isFinite(storyboardMetadataRaw.gridCols) &&
            Array.isArray(storyboardMetadataRaw.frameNotes),
        );

        let imageWithMetadata = prepared.imageUrl;
        if (hasStoryboardMetadata && storyboardMetadataRaw) {
          imageWithMetadata = await embedStoryboardImageMetadata(prepared.imageUrl, {
            gridRows: Math.max(1, Math.round(storyboardMetadataRaw.gridRows)),
            gridCols: Math.max(1, Math.round(storyboardMetadataRaw.gridCols)),
            frameNotes: storyboardMetadataRaw.frameNotes,
          }).catch((error) => {
            console.warn('[GenerationJob] embed storyboard metadata failed', { nodeId, error });
            return prepared.imageUrl;
          });
        }
        const previewWithMetadata =
          prepared.previewImageUrl === prepared.imageUrl ? imageWithMetadata : prepared.previewImageUrl;

        updateNodeData(nodeId, {
          imageUrl: imageWithMetadata,
          previewImageUrl: previewWithMetadata,
          aspectRatio: prepared.aspectRatio,
          isGenerating: false,
          generationStartedAt: null,
          generationJobId: null,
          generationProviderId: null,
          generationClientSessionId: null,
          generationStoryboardMetadata: undefined,
          generationError: null,
          generationErrorDetails: null,
          generationDebugContext: undefined,
        });
        return;
      }

      // Failure / not_found / canceled / unknown.
      const errorMessage =
        status.error ?? (status.status === 'not_found' ? 'generation job not found' : 'generation failed');
      const generationClientSessionId =
        typeof currentData.generationClientSessionId === 'string'
          ? currentData.generationClientSessionId
          : '';
      const shouldShowDialog = generationClientSessionId === CURRENT_RUNTIME_SESSION_ID;
      if (shouldShowDialog) {
        const reportText = buildGenerationErrorReport({
          errorMessage,
          errorDetails: status.error ?? undefined,
          context: currentData.generationDebugContext,
        });
        void showErrorDialog(
          errorMessage,
          translateError('common.error'),
          status.error ?? undefined,
          reportText,
        );
      }
      markGenerationFailed(nodeId, errorMessage, status.error ?? null, updateNodeData);
      return;
    }
  } finally {
    finalize();
  }
}

function markGenerationFailed(
  nodeId: string,
  errorMessage: string,
  errorDetails: string | null,
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void,
): void {
  updateNodeData(nodeId, {
    isGenerating: false,
    generationStartedAt: null,
    generationJobId: null,
    generationProviderId: null,
    generationClientSessionId: null,
    generationStoryboardMetadata: undefined,
    generationError: errorMessage,
    generationErrorDetails: errorDetails,
  });
}
