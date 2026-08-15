class CreateGameInvites < ActiveRecord::Migration[7.1]
  def change
    create_table :game_invites do |t|
      t.references :game, null: false, foreign_key: true
      t.references :inviter, null: false, foreign_key: { to_table: :users }
      t.references :invitee, null: false, foreign_key: { to_table: :users }
      t.string :status, null: false, default: "pending"

      t.timestamps
    end

    add_index :game_invites, [:invitee_id, :status]
    add_index :game_invites, [:game_id, :invitee_id, :status]
  end
end
