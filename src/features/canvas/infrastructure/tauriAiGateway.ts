import {
  generateImage,
  getGenerateImageJob,
  setApiKey,
  submitGenerateImageJob,
} from '@/commands/ai';
import { imageUrlToDataUrl, persistImageLocally } from '@/features/canvas/application/imageData';

import type { AiGateway, GenerateImagePayload } from '../application/ports';
import { submitDreaminaJob, getDreaminaJob } from './dreaminaGateway';
import { submitCustomProviderJob, getCustomProviderJob } from './customProviderGateway';

function isDreaminaModel(id: string): boolean { return id.startsWith('dreamina:'); }
function isCustomModel(id: string): boolean { return id.startsWith('custom:'); }
function isDreaminaJob(id: string): boolean { return id.startsWith('dreamina-local-'); }
function isCustomJob(id: string): boolean { return id.startsWith('custom-local-'); }

async function normalizeReferenceImages(payload: GenerateImagePayload): Promise<string[] | undefined> {
  const isKieModel = payload.model.startsWith('kie/');
  const isFalModel = payload.model.startsWith('fal/');
  const isCustomOrDreamina = isDreaminaModel(payload.model) || isCustomModel(payload.model);
  return payload.referenceImages
    ? await Promise.all(
      payload.referenceImages.map(async (imageUrl) =>
        isKieModel || isFalModel || isCustomOrDreamina
          ? await imageUrlToDataUrl(imageUrl)
          : await persistImageLocally(imageUrl)
      )
    )
    : undefined;
}

export const tauriAiGateway: AiGateway = {
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);

    return await generateImage({
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: payload.extraParams,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    // Route by model prefix: the built-in Rust gateway only knows about the
    // static built-in models (grsai/fal/kie/ppio); dreamina:* and custom:*
    // entries fan out to their own TS-side adapters.
    const request = {
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: payload.extraParams,
    };
    if (isDreaminaModel(payload.model)) return await submitDreaminaJob(request);
    if (isCustomModel(payload.model)) return await submitCustomProviderJob(request);
    return await submitGenerateImageJob(request);
  },
  getGenerateImageJob: async (jobId: string) => {
    if (isDreaminaJob(jobId)) return getDreaminaJob(jobId);
    if (isCustomJob(jobId)) return getCustomProviderJob(jobId);
    return await getGenerateImageJob(jobId);
  },
};
