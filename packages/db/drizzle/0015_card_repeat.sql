-- Repeating cards: a nullable JSON rule { unit, every } on the card.
-- null = a one-off card, so every existing row keeps behaving as before.
ALTER TABLE `card` ADD `repeat` text;
