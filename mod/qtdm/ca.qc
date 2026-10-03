/*
	ca.qc

	Clan Arena: rounds, full kit on spawn, no items, no self damage, the dead
	wait for the round to end, last team standing wins, first to N rounds.

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

void() Match_End;
void() Match_RespawnAll;
void(string s) CenterAll;
string(float t) TeamTitle;
float(float t, entity ignore) Team_Count;

float   CA_RESULT_TIME = 3;     // the round's result on screen
float   CA_COUNT_TIME = 3;      // respawned, counting down to the next round
float   ca_respawned;

float() CA_InRound =
{
	if (qt_mode != MODE_CA)
		return FALSE;
	return match_phase == PHASE_PLAYING;
};

void(entity p) CA_GiveKit =
{
	p.items = IT_AXE | IT_SHOTGUN | IT_SUPER_SHOTGUN | IT_NAILGUN |
		IT_SUPER_NAILGUN | IT_GRENADE_LAUNCHER | IT_ROCKET_LAUNCHER |
		IT_LIGHTNING | IT_ARMOR3;
	p.health = 100;
	p.armorvalue = 200;
	p.armortype = 0.8;
	p.ammo_shells = 100;
	p.ammo_nails = 200;
	p.ammo_rockets = 100;
	p.ammo_cells = 100;
	p.weapon = IT_ROCKET_LAUNCHER;
};

// alive players of team t in this round
float(float t) CA_Alive =
{
	local entity p;
	local float n;

	n = 0;
	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected && p.qteam == t && !p.ca_out && p.health > 0)
			n = n + 1;
		p = find (p, classname, "player");
	}
	return n;
};

void() CA_PlayerDied =
{
};

// Match_Start: everyone is already respawned with the kit
void() CA_StartMatch =
{
	ca_round = 1;
	match_endtime = 0;
	if (ca_roundtime)
		match_endtime = time + ca_roundtime;
	bprint (PRINT_HIGH, "Round 1\n");
	state_dirty = TRUE;
};

void(float winner) CA_RoundOver =
{
	if (winner == TEAM_RED)
		team1score = team1score + 1;
	else if (winner == TEAM_BLUE)
		team2score = team2score + 1;

	if (winner)
	{
		bprint (PRINT_HIGH, TeamTitle (winner));
		bprint (PRINT_HIGH, " wins round ");
		bprint (PRINT_HIGH, ftos (ca_round));
		bprint (PRINT_HIGH, " (RED ");
		bprint (PRINT_HIGH, ftos (team1score));
		bprint (PRINT_HIGH, " : ");
		bprint (PRINT_HIGH, ftos (team2score));
		bprint (PRINT_HIGH, " BLUE)\n");
		if (winner == TEAM_RED)
			CenterAll ("RED wins the round");
		else
			CenterAll ("BLUE wins the round");
	}
	else
	{
		bprint (PRINT_HIGH, "Round ");
		bprint (PRINT_HIGH, ftos (ca_round));
		bprint (PRINT_HIGH, " is a draw\n");
		CenterAll ("Round draw");
	}
	state_dirty = TRUE;

	if (team1score >= ca_roundlimit || team2score >= ca_roundlimit)
	{
		Match_End ();
		return;
	}

	match_phase = PHASE_ROUNDBREAK;
	match_endtime = 0;
	match_countdownend = time + CA_RESULT_TIME + CA_COUNT_TIME;
	ca_respawned = FALSE;
	countdown_last = 0;
};

// PLAYING in Clan Arena
void() CA_Frame =
{
	local float ar, ab;

	if (Team_Count (TEAM_RED, world) < 1 || Team_Count (TEAM_BLUE, world) < 1)
	{
		bprint (PRINT_HIGH, "A team has no players left\n");
		Match_End ();
		return;
	}

	ar = CA_Alive (TEAM_RED);
	ab = CA_Alive (TEAM_BLUE);
	if (!ar || !ab)
	{
		if (ar)
			CA_RoundOver (TEAM_RED);
		else if (ab)
			CA_RoundOver (TEAM_BLUE);
		else
			CA_RoundOver (TEAM_NONE);
		return;
	}

	if (match_endtime && time >= match_endtime)
	{
		bprint (PRINT_HIGH, "Round time is up\n");
		CA_RoundOver (TEAM_NONE);
	}
};

// ROUNDBREAK: result, then respawn and a short countdown
void() CA_RoundBreakFrame =
{
	local float n;

	if (!ca_respawned)
	{
		if (time < match_countdownend - CA_COUNT_TIME)
			return;
		ca_round = ca_round + 1;
		ca_respawned = TRUE;
		Match_RespawnAll ();
		state_dirty = TRUE;
	}

	n = ceil (match_countdownend - time);
	if (n <= 0)
	{
		match_phase = PHASE_PLAYING;
		match_countdownend = 0;
		match_endtime = 0;
		if (ca_roundtime)
			match_endtime = time + ca_roundtime;
		bprint (PRINT_HIGH, "Round ");
		bprint (PRINT_HIGH, ftos (ca_round));
		bprint (PRINT_HIGH, "\n");
		CenterAll ("FIGHT!");
		state_dirty = TRUE;
		return;
	}
	if (n != countdown_last)
	{
		countdown_last = n;
		CenterAll (strcat (strcat ("Round ", ftos (ca_round)), strcat ("\n\n", ftos (n))));
	}
};
