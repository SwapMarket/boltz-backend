import { DataTypes, Model, type Sequelize } from 'sequelize';

type BlockedApiNodeType = {
  nodeId: string;
  reason: string;
};

class BlockedApiNode extends Model implements BlockedApiNodeType {
  declare nodeId: string;
  declare reason: string;

  declare createdAt: Date;

  public static load = (sequelize: Sequelize): void => {
    BlockedApiNode.init(
      {
        nodeId: {
          type: new DataTypes.STRING(66),
          primaryKey: true,
          allowNull: false,
        },
        reason: {
          type: new DataTypes.TEXT(),
          allowNull: false,
        },
      },
      {
        sequelize,
        tableName: 'blocked_api_nodes',
      },
    );
  };
}

export default BlockedApiNode;
export { BlockedApiNodeType };
