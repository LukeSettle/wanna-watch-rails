class AddUniqueIndexToPlayersOnUserIdAndGameId < ActiveRecord::Migration[7.1]
  def change
    add_index :players, [:user_id, :game_id], unique: true
  end
end
