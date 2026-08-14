class AddModeToGames < ActiveRecord::Migration[7.1]
  def change
    add_column :games, :mode, :string, default: "classic", null: false
  end
end
