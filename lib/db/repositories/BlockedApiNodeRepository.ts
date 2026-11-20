import BlockedApiNode from '../models/BlockedApiNode';

class BlockedApiNodeRepository {
  public static isBlocked = async (nodeId: string): Promise<boolean> =>
    (await BlockedApiNode.findByPk(nodeId)) !== null;

  // Keeps the first reason when a node is blocked again
  public static block = async (nodeId: string, reason: string) => {
    await BlockedApiNode.findOrCreate({
      where: { nodeId },
      defaults: { nodeId, reason },
    });
  };

  public static unblock = async (nodeId: string): Promise<boolean> =>
    (await BlockedApiNode.destroy({ where: { nodeId } })) > 0;

  public static getAll = (): Promise<BlockedApiNode[]> =>
    BlockedApiNode.findAll({ order: [['createdAt', 'ASC']] });
}

export default BlockedApiNodeRepository;
