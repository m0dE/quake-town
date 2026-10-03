/*
	commands.qc

	Client console commands (SV_ParseClientCommand): ready, break, team, kill.

	Copyright (C) 2026 Quake Town contributors

	This program is free software; you can redistribute it and/or
	modify it under the terms of the GNU General Public License
	as published by the Free Software Foundation; either version 2
	of the License, or (at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

void() Match_Stop;
void(entity p, float t) Team_Request;
float(string s) TeamFromString;
string(float t) TeamName;

void() Cmd_Ready =
{
	if (!qt_readyup)
	{
		sprint (self, PRINT_HIGH, "This server needs no ready-up: just play\n");
		return;
	}
	if (match_phase != PHASE_WARMUP && match_phase != PHASE_COUNTDOWN)
	{
		sprint (self, PRINT_HIGH, "The match is on\n");
		return;
	}
	if (self.qt_ready)
	{
		sprint (self, PRINT_HIGH, "You are ready\n");
		return;
	}
	self.qt_ready = TRUE;
	bprint (PRINT_HIGH, self.netname);
	bprint (PRINT_HIGH, " is ready\n");
	warmup_hint_time = 0;
};

void() Cmd_Break =
{
	local entity p;
	local float humans, votes;

	if (!qt_readyup)
		return;
	if (match_phase == PHASE_WARMUP || match_phase == PHASE_COUNTDOWN)
	{
		if (!self.qt_ready)
		{
			sprint (self, PRINT_HIGH, "You are not ready\n");
			return;
		}
		self.qt_ready = FALSE;
		bprint (PRINT_HIGH, self.netname);
		bprint (PRINT_HIGH, " is not ready\n");
		return;
	}
	if (match_phase == PHASE_INTERMISSION || qt_isbot (self))
		return;

	// during a match: most humans must agree to stop it
	self.qt_break = TRUE;
	humans = votes = 0;
	p = find (world, classname, "player");
	while (p)
	{
		if (p.qt_connected && !qt_isbot (p))
		{
			humans = humans + 1;
			if (p.qt_break)
				votes = votes + 1;
		}
		p = find (p, classname, "player");
	}
	bprint (PRINT_HIGH, self.netname);
	bprint (PRINT_HIGH, " votes to stop the match (");
	bprint (PRINT_HIGH, ftos (votes));
	bprint (PRINT_HIGH, "/");
	bprint (PRINT_HIGH, ftos (floor (humans / 2) + 1));
	bprint (PRINT_HIGH, ")\n");
	if (votes * 2 > humans)
		Match_Stop ();
};

/*
============
SV_ParseClientCommand

The engine hands every client console command to the mod (self = player).
============
*/
void(string cmdline) SV_ParseClientCommand =
{
	local float argc;
	local string c;

	argc = tokenize (cmdline);
	if (argc < 1)
		return;
	c = argv (0);

	if (c == "ready")
		Cmd_Ready ();
	else if (c == "break" || c == "notready" || c == "unready")
		Cmd_Break ();
	else if (c == "kill")
		ClientKill ();
	else if (c == "team")
	{
		if (argc < 2 || !qt_teammode)
		{
			sprint (self, PRINT_HIGH, "Team: ");
			if (self.qteam)
				sprint (self, PRINT_HIGH, TeamName (self.qteam));
			else
				sprint (self, PRINT_HIGH, "none");
			sprint (self, PRINT_HIGH, "\n");
			return;
		}
		Team_Request (self, TeamFromString (argv (1)));
	}
	else
	{
		sprint (self, PRINT_HIGH, "Unknown command: ");
		sprint (self, PRINT_HIGH, c);
		sprint (self, PRINT_HIGH, "\n");
	}
};
