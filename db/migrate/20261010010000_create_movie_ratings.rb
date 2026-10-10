class CreateMovieRatings < ActiveRecord::Migration[7.1]
  def up
    create_table :movie_ratings do |t|
      t.references :user, null: false, foreign_key: true
      t.string :media_key, null: false
      t.boolean :liked, null: false
      t.boolean :watched, null: false, default: false
      t.integer :genre_ids, array: true, default: []
      t.timestamps
    end
    add_index :movie_ratings, [:user_id, :media_key], unique: true
    add_index :movie_ratings, [:user_id, :liked, :updated_at]

    # Seed taste profiles with every title users already liked in past games.
    execute <<~SQL.squish
      INSERT INTO movie_ratings (user_id, media_key, liked, watched, genre_ids, created_at, updated_at)
      SELECT players.user_id, liked.key, TRUE, FALSE, '{}', MAX(players.updated_at), MAX(players.updated_at)
      FROM players
      CROSS JOIN LATERAL unnest(players.liked_movie_ids) AS liked(key)
      WHERE liked.key LIKE 'movie:%' OR liked.key LIKE 'tv:%'
      GROUP BY players.user_id, liked.key
      ON CONFLICT (user_id, media_key) DO NOTHING
    SQL
  end

  def down
    drop_table :movie_ratings
  end
end
