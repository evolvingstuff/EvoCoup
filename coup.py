import random
from enum import Enum
from dataclasses import dataclass
from typing import List, Tuple
from copy import deepcopy


characters = Enum('Character', ['DUKE', 'ASSASSIN', 'AMBASSADOR', 'CAPTAIN', 'CONTESSA'])
actions = Enum('Action', ['INCOME', 'FOREIGN_AID', 'COUP', 'TAX', 'ASSASSINATE', 'EXCHANGE', 'STEAL'])
counteractions = Enum('Counteraction', ['BLOCK_FOREIGN_AID', 'BLOCK_STEAL', 'BLOCK_ASSASSINATE'])
COPIES_PER_CHARACTER = 3
CHARACTER_CARDS = 15
COINS = 50
STARTING_COINS = 2
STARTING_CARDS = 2
MAX_PLAYERS = 4
DEFAULT_PLAYERS = 2
DEFAULT_SEED = None
TOTAL_GAMES = 10_000


class GameState:
    def __init__(self):
        self.coin_pool = COINS
        self.round = 1
        deck = []
        for character in characters:
            for i in range(COPIES_PER_CHARACTER):
                deck.append(character)
        assert len(deck) == CHARACTER_CARDS
        random.shuffle(deck)
        self.deck = deck
        self.revealed_cards = []


class Player:
    def __init__(self, name, game_state):
        self.name = name
        game_state.coin_pool -= STARTING_COINS
        self.coins = STARTING_COINS
        self.hand = []
        for c in range(STARTING_CARDS):
            self.hand.append(game_state.deck.pop())

    def display(self):
        print('----------------------------')
        print(self.name)
        print(f'\tCoins: {self.coins}')
        print(f'\tHand:')
        for card in self.hand:
            print(f'\t\t{card}')
        print('----------------------------')

    def __str__(self):
        return self.name

    def __repr__(self):
        return self.__str__()


@dataclass
class ActionContext:
    player: Player = None
    player_truth: bool = None
    has_victim: bool = False
    required_card: characters = None
    action: actions = None
    counter_cards: List[characters] = None
    victory_effects: List[str] = None


@dataclass
class Possibility:
    player: Player = None
    players: List[Player] = None
    deck: List[characters] = None
    action_success = True
    victim: Player = None
    action_challenger: Player = None
    blocker: Player = None
    blocker_card: characters = None
    blocker_truth: bool = False
    blocker_challenger: Player = None
    player_reveals: bool = False
    blocker_reveals: bool = False
    ongoing_effects: List = None


def main():
    print('Coup')

    response = input('How many players? (2-4) ')
    if response == '':
        print(f'using default number of players: {DEFAULT_PLAYERS}')
        num_players = DEFAULT_PLAYERS
    else:
        num_players = int(response)
    assert 2 <= num_players <= 4
    response = input('random seed? ')
    if response == '':
        if DEFAULT_SEED is not None:
            print(f'using default random seed: {DEFAULT_SEED}')
            random.seed(DEFAULT_SEED)
    else:
        random.seed(int(response))

    wins = {}
    for g in range(TOTAL_GAMES):
        winner = play_game(num_players)
        if winner not in wins:
            wins[winner] = 0
        wins[winner] += 1
        print(f'DONE WITH GAME {g+1} of {TOTAL_GAMES}')
        print('')
        # response = input('another game?')
    print(f'wins: {wins}')


def play_game(num_players):
    game_state = GameState()
    players = []
    for p in range(num_players):
        name = f'Player {p + 1}'
        players.append(Player(name, game_state))
    assert len(game_state.deck) == CHARACTER_CARDS - num_players * STARTING_CARDS
    while len(players) > 1:
        players = game_round(players, game_state)
    print('')
    print(f'{players[0].name} won')
    return players[0].name


def prune_players(players: List[Player]) -> List[Player]:
    pruned = []
    for player in players:
        if len(player.hand) > 0:
            pruned.append(player)
        else:
            print(f'removed {player.name} from the game')
    return pruned


def game_round(players, game_state):
    print('=======================================================')
    print(f'round {game_state.round}')
    original_players = players[:]
    for player in original_players:
        print('---------------------------------------------------')
        for p in players:
            p.display()
        validate(players)
        print('')
        print(f'{player.name}\'s TURN')
        print('')
        if len(player.hand) == 0:
            print('')
            print(f'{player.name} is out of the game - skipping their turn')
            print('')
            continue
        action_character, action, victim = player_chooses_action(player, players)
        print(f'{player.name} action = {action} | required character = {action_character}')
        if victim is not None:
            print(f'victim = {victim}')
        successfully_challenged = challenge(player, action_character, action, players, game_state)
        players = prune_players(players)
        if len(players) == 1:
            print('game over')
            return players
        if successfully_challenged or player not in players:
            continue
        blocker, blocker_character = block(player, action, players, game_state)
        if blocker is not None:
            successfully_challenged_block = challenge_block(blocker, blocker_character, players, game_state)
            players = prune_players(players)
            if len(players) == 1:
                print('game over')
                return players
            if successfully_challenged_block or player not in players:
                continue
        successful_action(player, action, victim, game_state)
        players = prune_players(players)
        if len(players) == 1:
            print('game over')
            return players
        validate(players)
    game_state.round += 1
    if game_state.round > 50:  # TODO
        raise Exception('we all got bored and left')

    return players


def validate(players: List[Player]):
    for player in players:
        assert len(player.hand) > 0
        assert player.coins >= 0


def block(player: Player, action: actions, players: List[Player], gamestate) -> bool:
    assert len(player.hand) > 0
    if action in [actions.INCOME, actions.COUP, actions.TAX, actions.EXCHANGE]:
        print(f'{action} cannot be blocked')
        return None, None
    potential_blockers = [b for b in players if b != player]
    potential_blockers.append(None)
    blocker = random.choice(potential_blockers)

    if blocker is None:
        print('nobody attempts to block')
        return None, None
    else:
        assert len(blocker.hand) > 0

    if action == actions.FOREIGN_AID:
        blocker_character, blocker_action = characters.DUKE, counteractions.BLOCK_FOREIGN_AID
    elif action == actions.STEAL:
        if random.random() < 0.5:
            blocker_character, blocker_action = characters.AMBASSADOR, counteractions.BLOCK_STEAL
        else:
            blocker_character, blocker_action = characters.CAPTAIN, counteractions.BLOCK_STEAL
    elif action == actions.ASSASSINATE:
        blocker_character, blocker_action = characters.CONTESSA, counteractions.BLOCK_ASSASSINATE
    else:
        raise Exception(f'unexpected action {action}')
    print(f'{player.name} attempts to block {action} with {blocker_character} | {blocker_action}')
    return blocker, blocker_character


def challenge_block(blocker: Player, blocker_character: characters, players: List[Player], gamestate) -> bool:
    assert len(blocker.hand) > 0
    # TODO refactor into generic challenge function
    possible_challengers = [c for c in players if c != blocker]
    possible_challengers.append(None)
    challenger = random.choice(possible_challengers)

    def choose_to_reveal(player, player_has_card) -> bool:  # prove
        if player_has_card:
            if random.random() < 0.1:
                print(f'({player.name} had card but chooses not to reveal)')
                return False
            return True
        else:
            return False

    if challenger is None:
        print('nobody challenges')
        return False
    else:
        print(f'{challenger.name} challenges')

        if choose_to_reveal(blocker, blocker_character in blocker.hand):
            reveal_and_exchange(blocker, blocker_character, gamestate)
            lose_influence(challenger)
            return False
        else:
            lose_influence(blocker)
            return True


def successful_action(player: Player, action: actions, victim: Player, gamestate):
    assert len(player.hand) > 0
    if action == actions.INCOME:
        print(f'{player.name} successfully does INCOME and gains 1 coin')
        player.coins += 1
    elif action == actions.FOREIGN_AID:
        print(f'{player.name} successfully does FOREIGN AID and gains 2 coins')
        player.coins += 2
    elif action == actions.COUP:
        if len(victim.hand) == 0:
            print(f'{victim.name} is already out of the game')
            return
        print(f'{player.name} successfully plays COUP against {victim.name}')
        lose_influence(victim)
    elif action == actions.TAX:
        print(f'{player.name} successfully does TAX and gains 3 coins')
        player.coins += 3
    elif action == actions.ASSASSINATE:
        if len(victim.hand) == 0:
            print(f'{victim.name} is already out of the game')
            return
        print(f'{player.name} successfully plays ASSASSINATE against {victim.name}')
        lose_influence(victim)
        assert player.coins >= 3
        player.coins -= 3
        print(f'{player.name} pays 3 coins')
    elif action == actions.EXCHANGE:
        print(f'{player.name} successfully does EXCHANGE')
        card1 = gamestate.deck.pop(0)
        card2 = gamestate.deck.pop(0)
        print(f'{player.name} draws {card1} and {card2} from the deck')
        player.hand.append(card1)
        player.hand.append(card2)
        random.shuffle(player.hand)
        card1 = player.hand.pop(0)
        card2 = player.hand.pop(0)
        gamestate.deck.append(card1)
        gamestate.deck.append(card2)
        random.shuffle(gamestate.deck)
        print('shuffling deck')
        print(f'{player.name}\'s hand is now {player.hand}')
    elif action == actions.STEAL:
        if len(victim.hand) == 0:
            print(f'{victim.name} is already out of the game')
            return
        stolen = min(victim.coins, 2)
        victim.coins -= stolen
        player.coins += stolen
        print(f'{player.name} successfully plays STEAL against {victim.name}')
        print(f'{player.name} gains {stolen} coins')
        print(f'{victim.name} loses {stolen} coins')


def challenge(player: Player, action_character: characters, action: actions, players: List[Player], gamestate) -> bool:
    assert len(player.hand) > 0
    if action in [actions.INCOME, actions.FOREIGN_AID, actions.COUP]:
        print(f'{action} cannot be challenged')
        return False
    possible_challengers = [c for c in players if c != player]
    possible_challengers.append(None)
    challenger = random.choice(possible_challengers)

    def choose_to_reveal(player, player_has_card) -> bool:  # prove
        if player_has_card:
            if random.random() < 0.1:
                print(f'({player.name} had card but chooses not to reveal)')
                return False
            return True
        else:
            return False

    if challenger is None:
        print('nobody challenges')
        return False
    else:
        print(f'{challenger.name} challenges')
        assert len(challenger.hand) > 0

        if choose_to_reveal(player, action_character in player.hand):
            reveal_and_exchange(player, action_character, gamestate)
            lose_influence(challenger)
            return False
        else:
            lose_influence(player)
            return True


def reveal_and_exchange(player, action_character, gamestate):
    index = player.hand.index(action_character)
    assert player.hand[index] == action_character
    print(f'{player.name} reveals {action_character} and exchanges it with the deck')
    card = player.hand.pop(index)
    gamestate.deck.append(card)
    print(f'reshuffle deck')
    random.shuffle(gamestate.deck)
    card = gamestate.deck.pop(0)
    player.hand.append(card)
    print(f'({player.name}\'s hand is now {player.hand})')


def lose_influence(player):
    assert len(player.hand) > 0
    index = random.randint(0, len(player.hand) - 1)
    card = player.hand.pop(index)
    print(f'{player.name} loses an influence and reveals {card}')
    print(f'({player.name}\'s hand is now {player.hand})')


def player_chooses_action(player: Player, players: List[Player]) -> (actions, Player):
    options: List[actions] = []
    possible_victims = [v for v in players if v != player]
    if player.coins >= 10:
        options.append((None, actions.COUP, random.choice(possible_victims)))
    else:
        options.append((None, actions.INCOME, None))
        options.append((None, actions.FOREIGN_AID, None))
        if player.coins >= 7:
            options.append((None, actions.COUP, random.choice(possible_victims)))
        options.append((characters.DUKE, actions.TAX, None))
        if player.coins >= 3:
            options.append((characters.ASSASSIN, actions.ASSASSINATE, random.choice(possible_victims)))
        options.append((characters.AMBASSADOR, actions.EXCHANGE, None))
        options.append((characters.CAPTAIN, actions.STEAL, random.choice(possible_victims)))
    return random.choice(options)


if __name__ == '__main__':
    main()
