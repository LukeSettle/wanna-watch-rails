class AddLoadMoreCount < ActiveRecord::Migration[7.1]
  def change
    add_column :games, :load_more_count, :integer, default: 0
  end
end
