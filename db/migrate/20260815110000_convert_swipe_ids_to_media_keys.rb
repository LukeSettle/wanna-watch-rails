class ConvertSwipeIdsToMediaKeys < ActiveRecord::Migration[7.1]
  def up
    convert_player_column(:liked_movie_ids)
    convert_player_column(:seen_movie_ids)
    convert_game_column(:dealt_movie_ids)
  end

  def down
    revert_player_column(:liked_movie_ids)
    revert_player_column(:seen_movie_ids)
    revert_game_column(:dealt_movie_ids)
  end

  private

  def convert_player_column(column)
    add_column :players, :"#{column}_media", :text, array: true, default: []
    execute <<~SQL.squish
      UPDATE players
      SET #{column}_media = COALESCE(
        (SELECT array_agg(('movie:' || x::text)::text) FROM unnest(#{column}) AS x),
        '{}'::text[]
      )
    SQL
    remove_column :players, column
    rename_column :players, :"#{column}_media", column
  end

  def convert_game_column(column)
    add_column :games, :"#{column}_media", :text, array: true, default: []
    execute <<~SQL.squish
      UPDATE games
      SET #{column}_media = COALESCE(
        (SELECT array_agg(('movie:' || x::text)::text) FROM unnest(#{column}) AS x),
        '{}'::text[]
      )
    SQL
    remove_column :games, column
    rename_column :games, :"#{column}_media", column
  end

  def revert_player_column(column)
    add_column :players, :"#{column}_int", :integer, array: true, default: []
    execute <<~SQL.squish
      UPDATE players
      SET #{column}_int = COALESCE(
        (SELECT array_agg(split_part(x, ':', 2)::integer) FROM unnest(#{column}) AS x),
        '{}'::integer[]
      )
    SQL
    remove_column :players, column
    rename_column :players, :"#{column}_int", column
  end

  def revert_game_column(column)
    add_column :games, :"#{column}_int", :integer, array: true, default: []
    execute <<~SQL.squish
      UPDATE games
      SET #{column}_int = COALESCE(
        (SELECT array_agg(split_part(x, ':', 2)::integer) FROM unnest(#{column}) AS x),
        '{}'::integer[]
      )
    SQL
    remove_column :games, column
    rename_column :games, :"#{column}_int", column
  end
end
