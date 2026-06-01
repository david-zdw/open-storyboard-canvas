import {
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
  type CanvasEdge,
  type CanvasNode,
} from '../domain/canvasNodes';
import type { GraphImageResolver } from './ports';

type ImageSourceNodeData = {
  imageUrl?: string | null;
  previewImageUrl?: string | null;
};

function getImageSourceNodeData(node: CanvasNode | undefined): ImageSourceNodeData | null {
  if (!node || (!isUploadNode(node) && !isImageEditNode(node) && !isExportImageNode(node))) {
    return null;
  }
  return node.data as ImageSourceNodeData;
}

export class DefaultGraphImageResolver implements GraphImageResolver {
  collectInputImages(nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]): string[] {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const sourceNodeIds = edges
      .filter((edge) => edge.target === nodeId)
      .map((edge) => edge.source);

    const images = sourceNodeIds
      .map((sourceId) => nodeById.get(sourceId))
      .flatMap((node) => this.extractImages(node));

    return [...new Set(images)];
  }

  private extractImages(node: CanvasNode | undefined): string[] {
    const data = getImageSourceNodeData(node);
    const imageUrl = data?.imageUrl || data?.previewImageUrl;
    return imageUrl ? [imageUrl] : [];
  }
}

export const graphImageResolver = new DefaultGraphImageResolver();
