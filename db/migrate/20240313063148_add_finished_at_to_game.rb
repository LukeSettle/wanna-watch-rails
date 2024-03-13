class AddFinishedAtToGame < ActiveRecord::Migration[7.1]
  def change
    add_column :games, :finished_at, :datetime
  end
end
