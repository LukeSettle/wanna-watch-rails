class AddSeenMovieIdsToPlayers < ActiveRecord::Migration[7.1]
  def change
    add_column :players, :seen_movie_ids, :integer, array: true, default: []
  end
end
