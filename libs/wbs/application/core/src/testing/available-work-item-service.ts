import { type PlanTree, WorkItemService } from '../service/work-item.service';

/** A test service whose core fixture guarantees that Fast scheduling is available. */
export class AvailableWorkItemService extends WorkItemService {
  override async tree(projectId: string): Promise<PlanTree | null> {
    const tree = await super.tree(projectId);
    if (tree === null) return null;
    if ('kind' in tree) {
      throw new Error(`test scheduler refused ${tree.engine}`);
    }
    return tree;
  }
}
