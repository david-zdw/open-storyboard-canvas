import { memo } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiChipButton, UiPanel } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface NodeDeleteToolbarProps {
  nodeId: string;
}

export const NodeDeleteToolbar = memo(({ nodeId }: NodeDeleteToolbarProps) => {
  const { t } = useTranslation();
  const deleteNode = useCanvasStore((state) => state.deleteNode);

  return (
    <ReactFlowNodeToolbar
      nodeId={nodeId}
      isVisible
      position={NODE_TOOLBAR_POSITION}
      align={NODE_TOOLBAR_ALIGN}
      offset={NODE_TOOLBAR_OFFSET}
      className={NODE_TOOLBAR_CLASS}
    >
      <UiPanel className="flex items-center gap-1 rounded-full p-1">
        <UiChipButton
          className="h-8 rounded-full border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-300 hover:bg-red-500/25"
          onClick={(event) => {
            event.stopPropagation();
            deleteNode(nodeId);
          }}
          title={t('common.delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('common.delete')}
        </UiChipButton>
      </UiPanel>
    </ReactFlowNodeToolbar>
  );
});

NodeDeleteToolbar.displayName = 'NodeDeleteToolbar';
