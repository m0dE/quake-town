/*
	selftest.qc

	Scripted checks run inside a real world (serverinfo "qt_selftest"), used by
	tools/qc/test-modes.mjs with the engine's qtrun. Never active otherwise.
	  ctf: a red player takes the blue flag and captures it; the next carrier is
	       killed (drop), a blue player returns the flag; another drop returns
	       on its own after 30 s.

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.
*/

entity(float t) ST_Player =
{
	local entity p;

	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected && p.qteam == t && p.health > 0)
			return p;
		p = find (p, classname, "player");
	}
	return world;
};

void(entity p, entity f) ST_Put =
{
	if (p.classname != "player")
		return;
	setorigin (p, f.origin + '0 0 30');
	p.velocity = '0 0 0';
};

void(string s) ST_Say =
{
	bprint (PRINT_HIGH, "selftest: ");
	bprint (PRINT_HIGH, s);
	bprint (PRINT_HIGH, "\n");
};

// a DM spawn far from both flags, to drop a flag in the open
entity() ST_MidSpot =
{
	local entity e, best;
	local float d, d2, bd;

	best = world;
	bd = -1;
	e = find (world, classname, "info_player_deathmatch");
	while (e)
	{
		d = vlen (e.origin - flag_red.origin);
		d2 = vlen (e.origin - flag_blue.origin);
		if (d2 < d)
			d = d2;
		if (d > bd)
		{
			bd = d;
			best = e;
		}
		e = find (e, classname, "info_player_deathmatch");
	}
	return best;
};

void(entity p) ST_PutMid =
{
	local entity m;

	if (p.classname != "player")
		return;
	m = ST_MidSpot ();
	setorigin (p, m.origin);
	p.velocity = '0 0 0';
};

void(float ok, string what) ST_Check =
{
	bprint (PRINT_HIGH, "selftest: ");
	bprint (PRINT_HIGH, what);
	if (ok)
		bprint (PRINT_HIGH, " ok\n");
	else
		bprint (PRINT_HIGH, " FAILED\n");
};

void() SelfTest_Frame =
{
	local entity r, b;
	local float t;

	if (infokey (world, "qt_selftest") != "ctf")
		return;
	if (match_phase != PHASE_PLAYING || !flag_red || !flag_blue)
		return;
	t = time - match_starttime;
	r = ST_Player (TEAM_RED);
	b = ST_Player (TEAM_BLUE);

	if (selftest_step == 0 && t > 2)
	{
		selftest_step = 1;
		ST_Put (r, flag_blue);
	}
	else if (selftest_step == 1 && t > 3)
	{
		selftest_step = 2;
		ST_Check (flag_blue.flagstate == FLAG_CARRIED, "pickup");
		ST_Put (flag_blue.flagcarrier, flag_red);
	}
	else if (selftest_step == 2 && t > 4)
	{
		selftest_step = 3;
		ST_Check (team1caps == 1 && flag_blue.flagstate == FLAG_AT_BASE, "capture");
		ST_Put (r, flag_blue);
	}
	else if (selftest_step == 3 && t > 5)
	{
		selftest_step = 4;
		ST_PutMid (flag_blue.flagcarrier);
	}
	else if (selftest_step == 4 && t > 6)
	{
		selftest_step = 5;
		if (flag_blue.flagcarrier)
			T_Damage (flag_blue.flagcarrier, world, world, 1000);
		ST_Check (flag_blue.flagstate == FLAG_DROPPED, "drop");
	}
	else if (selftest_step == 5 && t > 6.2)
	{
		selftest_step = 6;
		ST_Put (b, flag_blue);
	}
	else if (selftest_step == 6 && t > 7)
	{
		selftest_step = 7;
		ST_Check (flag_blue.flagstate == FLAG_AT_BASE, "return by a teammate");
		ST_Put (r, flag_blue);
	}
	else if (selftest_step == 7 && t > 9)
	{
		selftest_step = 8;
		ST_PutMid (flag_blue.flagcarrier);
	}
	else if (selftest_step == 8 && t > 10)
	{
		selftest_step = 10;     // CTF_FlagTouch ignores everyone now
		if (flag_blue.flagcarrier)
			T_Damage (flag_blue.flagcarrier, world, world, 1000);
		ST_Check (flag_blue.flagstate == FLAG_DROPPED, "second drop");
	}
	else if (selftest_step == 10 && t > 42)
	{
		selftest_step = 11;
		ST_Check (flag_blue.flagstate == FLAG_AT_BASE, "auto return after 30 s");
	}
};
