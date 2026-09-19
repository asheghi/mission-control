import type { ParticipantKind, Priority } from "../../../domain/types";
import type { ViewComponentProps } from "../../shell/types";

export interface BacklogItem {
  readonly id: number;
  readonly title: string;
  readonly priority: Priority;
  readonly parentId: number | null;
  readonly assignee: { readonly id: number; readonly name: string; readonly kind: ParticipantKind } | null;
  readonly labels: readonly { readonly id: number; readonly name: string }[];
}

export interface BacklogGroup {
  readonly item: BacklogItem;
  readonly children: readonly BacklogItem[];
}

export interface BacklogViewProps extends ViewComponentProps {}
