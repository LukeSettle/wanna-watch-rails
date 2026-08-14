class AddDeckToGames < ActiveRecord::Migration[7.1]
  def change
    add_column :games, :deck, :jsonb, default: []
    add_column :games, :deck_round, :integer, default: -1
    add_column :games, :dealt_movie_ids, :integer, array: true, default: []
  end
end
