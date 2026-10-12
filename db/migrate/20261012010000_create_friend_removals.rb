class CreateFriendRemovals < ActiveRecord::Migration[7.1]
  def change
    create_table :friend_removals do |t|
      t.references :user, null: false, foreign_key: true
      t.references :friend, null: false, foreign_key: { to_table: :users }
      t.timestamps
    end
    add_index :friend_removals, [:user_id, :friend_id], unique: true
  end
end
